// src/llm/videoIngest.ts — turn a video URL into an AI-SDK FilePart, size-branched.
// Small (encoded < VIDEO_INLINE_MAX_BYTES): inline base64 in one request. Large (up to
// the hard cap VIDEO_MAX_BYTES): Gemini Files API (upload → poll ACTIVE → reference by
// fileUri). The caller deletes the uploaded file via the returned `cleanup` AFTER the
// model has read the fileData URI — deleting before generateObject runs makes every
// large video fail. Over the hard cap, or no Google key, or any Files-API error:
// { skip } so the caller records a per-pod reason (never aborts the cycle). A skip
// AFTER a successful upload deletes the orphaned remote file first (best-effort).
import type { FilePart } from 'ai'

/** NaN-safe env parse: a non-numeric (or non-positive) value falls back to the default.
 *  `Number(x ?? d)` would yield NaN on a garbage value (the `??` only catches undefined),
 *  silently disabling the cap — every comparison against NaN is false. */
function envBytes(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Inline-vs-Files-API threshold. Gemini inline request payloads are bounded (~20 MB
 *  incl. base64 overhead); above this we MUST use the Files API. Env-overridable. */
export const VIDEO_INLINE_MAX_BYTES = envBytes(process.env.VIDEO_INLINE_MAX_BYTES, 20 * 1024 * 1024)
/** Hard cap: a larger pod is skipped (reason recorded) BEFORE any byte is fetched. */
export const VIDEO_MAX_BYTES = envBytes(process.env.VIDEO_MAX_BYTES, 200 * 1024 * 1024)

/** Raw-byte ceiling for the inline path: base64 inflates by ~4/3, so the ENCODED size is
 *  what Gemini's inline payload limit bounds. A raw file just under VIDEO_INLINE_MAX_BYTES
 *  would encode to ~33% larger and be rejected — compare the raw length against the size
 *  that encodes to exactly the limit. */
const INLINE_RAW_MAX_BYTES = Math.floor((VIDEO_INLINE_MAX_BYTES * 3) / 4)

const FILES_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const UPLOAD_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta/files'

// Per-call timeouts so a hung Files-API request can't freeze the single-threaded cycle.
const DOWNLOAD_TIMEOUT_MS = 60_000
const UPLOAD_TIMEOUT_MS = 60_000
const STATUS_TIMEOUT_MS = 15_000
const DELETE_TIMEOUT_MS = 10_000

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export interface IngestArgs {
  url: string
  mediaType: string
  /** Content-Length from detection; null when unknown (we then fetch + measure). */
  contentLength: number | null
  /** The Google API key from the provider key registry (undefined ⇒ skip). */
  googleKey: string | undefined
  fetchImpl?: FetchImpl
  /** poll cadence + count for the Files-API ACTIVE wait (injectable for tests). */
  pollIntervalMs?: number
  maxPolls?: number
}

/** A resolved FilePart plus an OPTIONAL cleanup the caller MUST run after the model has
 *  consumed the part (the Files-API path returns one to delete the uploaded file; the
 *  inline path has nothing to clean up). */
export type IngestResult = { part: FilePart; cleanup?: () => Promise<void> } | { skip: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** A single fetch wrapped in an AbortController timeout. Throws on timeout/abort just like
 *  a network error, so every caller's existing try/catch turns it into a skip. */
async function fetchWithTimeout(fetchImpl: FetchImpl, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

/** Resolve a video URL to a FilePart, branching on size; skip-with-reason on any
 *  failure path. The returned FilePart's `data` is a base64 string (inline) or a
 *  `URL` pointing at the Files-API fileUri (the SDK emits inlineData vs fileData).
 *  The Files-API path returns a `cleanup` the caller runs AFTER the model reads the URI. */
export async function ingestVideo(args: IngestArgs): Promise<IngestResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  if (!args.googleKey) return { skip: 'video scoring needs a Google API key (set LLM_KEY_GOOGLE)' }
  const googleKey = args.googleKey
  // Pre-fetch hard-cap gate: when detection threaded a Content-Length, a known-oversize
  // video is skipped BEFORE a single byte is downloaded.
  if (args.contentLength !== null && args.contentLength > VIDEO_MAX_BYTES) {
    return { skip: `video ${args.contentLength} bytes exceeds VIDEO_MAX_BYTES (${VIDEO_MAX_BYTES})` }
  }

  // Fetch the bytes (small case, or unknown size). A timeout bounds a slow download.
  // Buffer (not a generic Uint8Array<ArrayBufferLike>) is a concrete BodyInit/BlobPart,
  // so it threads cleanly into both the inline base64 and the Files-API upload body.
  let bytes: Buffer
  try {
    const res = await fetchWithTimeout(fetchImpl, args.url, {}, DOWNLOAD_TIMEOUT_MS)
    if (!res.ok) return { skip: `video fetch failed (HTTP ${res.status})` }
    bytes = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    return { skip: `video fetch error: ${e instanceof Error ? e.message : String(e)}` }
  }
  // Enforce the hard cap again on the ACTUAL size (covers contentLength === null).
  if (bytes.byteLength > VIDEO_MAX_BYTES) {
    return { skip: `video ${bytes.byteLength} bytes exceeds VIDEO_MAX_BYTES (${VIDEO_MAX_BYTES})` }
  }

  // Small → inline base64 FilePart. Branch on the RAW size that ENCODES within the inline
  // limit (base64 adds ~33%), not the raw size against the limit — otherwise an 18 MB raw
  // file (~24 MB encoded) takes the inline path and Gemini rejects the oversized payload.
  if (bytes.byteLength <= INLINE_RAW_MAX_BYTES) {
    return { part: { type: 'file', data: Buffer.from(bytes).toString('base64'), mimeType: args.mediaType } }
  }

  // Large → Gemini Files API: upload, poll ACTIVE, reference by URL. The caller deletes the
  // file via the returned `cleanup` AFTER generateObject consumes the fileData URI. Every
  // post-upload skip path deletes the orphaned file first (best-effort) so we never leak.
  let fileName: string | undefined
  try {
    const up = await fetchWithTimeout(fetchImpl, `${UPLOAD_BASE}?key=${googleKey}`, {
      method: 'POST',
      headers: { 'X-Goog-Upload-Protocol': 'raw', 'Content-Type': args.mediaType },
      // A Buffer IS a valid fetch body at runtime, but @types/node's BodyInit union
      // rejects Buffer<ArrayBufferLike> (a known TS 5.7 ArrayBufferLike-vs-ArrayBuffer
      // variance false-positive); the cast is the localized, correct fix.
      body: bytes as unknown as BodyInit,
    }, UPLOAD_TIMEOUT_MS)
    if (!up.ok) return { skip: `Gemini Files API upload failed (HTTP ${up.status})` }
    const uploaded = (await up.json()) as { file?: { name?: string; uri?: string; state?: string } }
    fileName = uploaded.file?.name
    let uri = uploaded.file?.uri
    let state = uploaded.file?.state
    // Upload returned a name but no usable uri (or no name): delete what we can, then skip.
    if (!fileName || !uri) {
      if (fileName) await deleteFile(fetchImpl, fileName, googleKey)
      return { skip: 'Gemini Files API upload returned no file uri' }
    }

    const maxPolls = args.maxPolls ?? 60 // ~60s default; large clips can transcode past 30s
    for (let i = 0; state !== 'ACTIVE' && i < maxPolls; i++) {
      if (state === 'FAILED') break
      await sleep(args.pollIntervalMs ?? 1000)
      let stat: Response
      try {
        stat = await fetchWithTimeout(fetchImpl, `${FILES_BASE}/${fileName}?key=${googleKey}`, { method: 'GET' }, STATUS_TIMEOUT_MS)
      } catch (e) {
        // Status poll timed out / errored: delete the orphan, then skip.
        await deleteFile(fetchImpl, fileName, googleKey)
        return { skip: `Gemini Files API status error: ${e instanceof Error ? e.message : String(e)}` }
      }
      if (!stat.ok) {
        await deleteFile(fetchImpl, fileName, googleKey)
        return { skip: `Gemini Files API status failed (HTTP ${stat.status})` }
      }
      const cur = (await stat.json()) as { uri?: string; state?: string }
      state = cur.state
      if (cur.uri) uri = cur.uri
    }
    if (state !== 'ACTIVE') {
      await deleteFile(fetchImpl, fileName, googleKey)
      return { skip: `Gemini Files API file never reached ACTIVE (state ${state ?? 'unknown'})` }
    }
    // Reference by URL → SDK emits fileData. Hand the caller a cleanup that deletes the
    // remote file AFTER the model has read the uri (deleting here would 404 the request).
    const part: FilePart = { type: 'file', data: new URL(uri), mimeType: args.mediaType }
    const name = fileName
    return { part, cleanup: () => deleteFile(fetchImpl, name, googleKey) }
  } catch (e) {
    if (fileName) await deleteFile(fetchImpl, fileName, googleKey)
    return { skip: `Gemini Files API error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function deleteFile(fetchImpl: FetchImpl, name: string, key: string): Promise<void> {
  try { await fetchWithTimeout(fetchImpl, `${FILES_BASE}/${name}?key=${key}`, { method: 'DELETE' }, DELETE_TIMEOUT_MS) } catch { /* best-effort */ }
}
