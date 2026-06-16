// src/llm/videoIngest.ts — turn a video URL into an AI-SDK FilePart, size-branched.
// Small (< VIDEO_INLINE_MAX_BYTES): inline base64 in one request. Large (up to the
// hard cap VIDEO_MAX_BYTES): Gemini Files API (upload → poll ACTIVE → reference by
// fileUri → delete after). Over the hard cap, or no Google key, or any Files-API
// error: { skip } so the caller records a per-pod reason (never aborts the cycle).
import type { FilePart } from 'ai'

/** Inline-vs-Files-API threshold. Gemini inline request payloads are bounded (~20 MB
 *  incl. base64 overhead); above this we MUST use the Files API. Env-overridable. */
export const VIDEO_INLINE_MAX_BYTES = Number(process.env.VIDEO_INLINE_MAX_BYTES ?? 20 * 1024 * 1024)
/** Hard cap: a larger pod is skipped (reason recorded) BEFORE any byte is fetched. */
export const VIDEO_MAX_BYTES = Number(process.env.VIDEO_MAX_BYTES ?? 200 * 1024 * 1024)

const FILES_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const UPLOAD_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta/files'

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

export type IngestResult = { part: FilePart } | { skip: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Resolve a video URL to a FilePart, branching on size; skip-with-reason on any
 *  failure path. The returned FilePart's `data` is a base64 string (inline) or a
 *  `URL` pointing at the Files-API fileUri (the SDK emits inlineData vs fileData). */
export async function ingestVideo(args: IngestArgs): Promise<IngestResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  if (!args.googleKey) return { skip: 'video scoring needs a Google API key (set LLM_KEY_GOOGLE)' }
  if (args.contentLength !== null && args.contentLength > VIDEO_MAX_BYTES) {
    return { skip: `video ${args.contentLength} bytes exceeds VIDEO_MAX_BYTES (${VIDEO_MAX_BYTES})` }
  }

  // Fetch the bytes (small case, or unknown size). A 60s cap bounds a slow download.
  // Buffer (not a generic Uint8Array<ArrayBufferLike>) is a concrete BodyInit/BlobPart,
  // so it threads cleanly into both the inline base64 and the Files-API upload body.
  let bytes: Buffer
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 60_000)
    try {
      const res = await fetchImpl(args.url, { signal: ctrl.signal })
      if (!res.ok) return { skip: `video fetch failed (HTTP ${res.status})` }
      bytes = Buffer.from(await res.arrayBuffer())
    } finally {
      clearTimeout(t)
    }
  } catch (e) {
    return { skip: `video fetch error: ${e instanceof Error ? e.message : String(e)}` }
  }
  // Enforce the hard cap again on the ACTUAL size (covers contentLength === null).
  if (bytes.byteLength > VIDEO_MAX_BYTES) {
    return { skip: `video ${bytes.byteLength} bytes exceeds VIDEO_MAX_BYTES (${VIDEO_MAX_BYTES})` }
  }

  // Small → inline base64 FilePart.
  if (bytes.byteLength < VIDEO_INLINE_MAX_BYTES) {
    return { part: { type: 'file', data: Buffer.from(bytes).toString('base64'), mimeType: args.mediaType } }
  }

  // Large → Gemini Files API: upload, poll ACTIVE, reference by URL, delete after.
  let fileName: string | undefined
  try {
    const up = await fetchImpl(`${UPLOAD_BASE}?key=${args.googleKey}`, {
      method: 'POST',
      headers: { 'X-Goog-Upload-Protocol': 'raw', 'Content-Type': args.mediaType },
      // A Buffer IS a valid fetch body at runtime, but @types/node's BodyInit union
      // rejects Buffer<ArrayBufferLike> (a known TS 5.7 ArrayBufferLike-vs-ArrayBuffer
      // variance false-positive); the cast is the localized, correct fix.
      body: bytes as unknown as BodyInit,
    })
    if (!up.ok) return { skip: `Gemini Files API upload failed (HTTP ${up.status})` }
    const uploaded = (await up.json()) as { file?: { name?: string; uri?: string; state?: string } }
    fileName = uploaded.file?.name
    let uri = uploaded.file?.uri
    let state = uploaded.file?.state
    if (!fileName || !uri) return { skip: 'Gemini Files API upload returned no file uri' }

    const maxPolls = args.maxPolls ?? 30
    for (let i = 0; state !== 'ACTIVE' && i < maxPolls; i++) {
      if (state === 'FAILED') break
      await sleep(args.pollIntervalMs ?? 1000)
      const stat = await fetchImpl(`${FILES_BASE}/${fileName}?key=${args.googleKey}`, { method: 'GET' })
      if (!stat.ok) return { skip: `Gemini Files API status failed (HTTP ${stat.status})` }
      const cur = (await stat.json()) as { uri?: string; state?: string }
      state = cur.state
      if (cur.uri) uri = cur.uri
    }
    if (state !== 'ACTIVE') {
      await deleteFile(fetchImpl, fileName, args.googleKey)
      return { skip: `Gemini Files API file never reached ACTIVE (state ${state ?? 'unknown'})` }
    }
    // Reference by URL → SDK emits fileData. Delete the remote file after referencing;
    // the request only needs the uri, not continued storage.
    const part: FilePart = { type: 'file', data: new URL(uri), mimeType: args.mediaType }
    await deleteFile(fetchImpl, fileName, args.googleKey)
    return { part }
  } catch (e) {
    if (fileName) await deleteFile(fetchImpl, fileName, args.googleKey)
    return { skip: `Gemini Files API error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function deleteFile(fetchImpl: FetchImpl, name: string, key: string): Promise<void> {
  try { await fetchImpl(`${FILES_BASE}/${name}?key=${key}`, { method: 'DELETE' }) } catch { /* best-effort */ }
}
