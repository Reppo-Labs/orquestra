# Gemini Video Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan. Each task is a TDD loop (failing test → run → minimal impl → run → commit). Do NOT skip the run-the-failing-test step; the FAIL output is the proof the test exercises the new behavior.

**Goal:** Make a Gemini-resolved scorer actually *watch* a video pod. Phase A let an operator route a datanet to `google`/Gemini; Phase B detects a video pod by its `Content-Type`, fetches the bytes size-branched (inline base64 under ~20 MB, else the Gemini Files API), threads the video through `buildVotePrompt` as a multimodal `FilePart`, and through `generateObjectWithRetry` as `messages`. Every failure (no Google key, a non-Gemini model on a video pod, over-size, fetch/Gemini error) **skips that pod with a recorded reason** via the existing per-datanet/per-pod skip mechanism. The text path stays byte-for-byte unchanged.

**Architecture:** The pod-enrichment loop in `buildCycleDeps` (`src/runtime/wiring.ts`) gains a `Content-Type` probe (HEAD, ranged-GET fallback). A `video/*` pod is marked by setting `VoterPod.mediaUrl` + `VoterPod.mediaType` (new optional fields) instead of the text `description` enrichment. A size-branched ingest helper (`src/llm/videoIngest.ts`) turns `mediaUrl` into an AI-SDK `FilePart` whose `data` is either a base64 string (inline → SDK emits `inlineData`) or a `new URL(fileUri)` from the Gemini Files API (→ SDK emits `fileData`). The voter scorer (`createLlmScorer`) resolves a per-pod model via Phase A's `resolveScoringModel`, builds multimodal message parts via `buildVotePrompt`, and calls `generateObjectWithRetry` with `messages`. A scorer that throws a skip reason is caught by `selectVotes`' existing per-pod `try/catch`. A per-cycle video-pod cap bounds the operator's API bill + cycle latency.

**Tech Stack:** TypeScript (ESM, `NodeNext`, `.js` import extensions), Zod 3, Vercel AI SDK `ai@4.3.19` + `@ai-sdk/google@1.2.22`, vitest 2 (colocated `*.test.ts`, `node` env), Node ≥ 22.5. The Gemini Files API is plain REST against `https://generativelanguage.googleapis.com/v1beta/files` (the SDK has no upload helper — it only recognizes a `file` part whose `data` is a `.../v1beta/files/...` URL and converts it to `fileData`).

> **Phase A contract — referenced, NOT redefined here.** This plan assumes Phase A has already landed:
> - Config: `DatanetPolicy` (`src/config/schema.ts`, `.strict()`) has the optional field `model?: { provider: LlmProvider; model: string }` and the schema exports `LlmProviderEnum = z.enum(['anthropic','openai','google','surplus','virtuals'])`.
> - The **provider key registry**: a `Map<LlmProvider, string>` built at startup from `LLM_KEY_ANTHROPIC|OPENAI|GOOGLE|VIRTUALS|SURPLUS` plus `LLM_PROVIDER`+`LLM_API_KEY` (default provider's key), exposed to the wiring.
> - `resolveScoringModel({ policyModel, isVideo, registry, defaultProvider, defaultModel })` → `{ model: LanguageModel } | { skip: string }` (lives in `src/llm/`), implementing the spec's resolution order. Phase B *calls* this; it does not implement it.
>
> If any of these symbols is missing when you start, STOP — Phase A is not done; this plan cannot land standalone.

---

## File Structure

| File | Create / Modify | Responsibility |
| --- | --- | --- |
| `src/voter/types.ts` | Modify | `VoterPod` gains `mediaUrl?: string` + `mediaType?: string` (a video pod the scorer must watch, distinct from the text `description`). |
| `src/voter/types.test.ts` | Create | Type-level assertion that a `VoterPod` literal with `mediaUrl`/`mediaType` compiles and the fields are optional. |
| `src/llm/contentType.ts` | Create | `detectContentType(url, fetchImpl?)` — HEAD probe with a ranged-GET (`Range: bytes=0-0`) fallback; returns `{ mediaType, contentLength }` or `null`. `isVideoType(mediaType)` predicate. |
| `src/llm/contentType.test.ts` | Create | HEAD returns `video/mp4` → routed; HEAD 405 → ranged-GET fallback used; non-video → not routed; total failure → `null`. |
| `src/llm/videoIngest.ts` | Create | `VIDEO_INLINE_MAX_BYTES`, `VIDEO_MAX_BYTES`; `ingestVideo({ url, mediaType, contentLength, googleKey, fetchImpl? })` → `{ part: FilePart } | { skip: string }`. Inline base64 under the inline cap; Files API (upload → poll ACTIVE → reference → delete) up to the hard cap; over the hard cap → skip-with-reason. |
| `src/llm/videoIngest.test.ts` | Create | Inline branch (small) builds a base64 `FilePart`; Files-API branch (large) uploads/polls/derefs and returns a URL `FilePart` + deletes; over-`VIDEO_MAX_BYTES` → skip; upload error / non-ACTIVE → skip; missing google key → skip. All `fetch` mocked. |
| `src/voter/score.ts` | Modify | `buildVotePrompt` returns `{ system, prompt }` (text, unchanged) **or** `{ system, messages }` (video: rubric text part + video `FilePart` + instruction). `createLlmScorer` gains video-aware resolution + ingest, calling `generateObjectWithRetry` with `messages` for video pods. |
| `src/voter/score.test.ts` | Modify | Existing text assertions stay; add: video pod → `messages` form with the rubric text + a `file` part; text pod → still the string `prompt`. |
| `src/llm/generate.ts` | Modify | `generateObjectWithRetry` accepts EITHER `prompt: string` OR `messages: CoreMessage[]` (via an options arg); the `prompt` path is byte-for-byte unchanged. |
| `src/llm/generate.test.ts` | Create | `prompt` path calls `generateObject` with `{ prompt }`; `messages` path calls it with `{ messages }`; retry-once-then-throw holds for both. |
| `src/runtime/wiring.ts` | Modify | Pod-enrichment loop: probe `Content-Type`; `video/*` → set `mediaUrl`/`mediaType` (skip the text fetch); else unchanged. Thread the registry + default provider/model + `videoPodsPerCycle` cap into the scorer. New `CycleWiring` fields. |
| `src/runtime/wiring.test.ts` | Modify | A video-typed pod gets `mediaUrl`/`mediaType` set and is NOT text-enriched; a text pod is enriched exactly as before; the per-cycle video cap is threaded. |
| `src/index.ts` | Modify | Thread Phase A's registry + default provider/model + the env `VIDEO_PODS_PER_CYCLE` into the `CycleWiring` it already constructs. |
| `.env.example` | Modify | Document `VIDEO_INLINE_MAX_BYTES`, `VIDEO_MAX_BYTES`, `VIDEO_PODS_PER_CYCLE` (the byte caps + per-cycle count cap). |

---

## Task 1 — `VoterPod` gains `mediaUrl?` + `mediaType?`

**Files:**
- Modify: `src/voter/types.ts` (interface `VoterPod`, lines 6–13)
- Test: `src/voter/types.test.ts` (create)

- [ ] **Step 1: Write the failing test.** Create `src/voter/types.test.ts`:
  ```ts
  // src/voter/types.test.ts
  import { describe, it, expect } from 'vitest'
  import type { VoterPod } from './types.js'

  describe('VoterPod media fields', () => {
    it('accepts an optional mediaUrl + mediaType (a video pod)', () => {
      const videoPod: VoterPod = {
        podId: '1', validityEpoch: '1', name: 'clip', description: '',
        mediaUrl: 'https://x/clip.mp4', mediaType: 'video/mp4',
      }
      expect(videoPod.mediaType).toBe('video/mp4')
    })
    it('leaves a text pod (no media fields) valid', () => {
      const textPod: VoterPod = { podId: '2', validityEpoch: '1', name: 't', description: 'd' }
      expect(textPod.mediaUrl).toBeUndefined()
    })
  })
  ```
- [ ] **Step 2: Run it — expect FAIL** (TS error: `mediaUrl`/`mediaType` do not exist on `VoterPod`):
  `npx vitest run src/voter/types.test.ts`
- [ ] **Step 3: Minimal implementation.** In `src/voter/types.ts`, replace the `VoterPod` interface body so it ends with the two new optional fields after `url`:
  ```ts
  export interface VoterPod {
    podId: string
    validityEpoch: string
    name: string
    description: string
    /** IPFS content URL (the pod's dataset); used to enrich `description` for scoring. */
    url?: string
    /** Set when the pod's `url` resolves to `video/*`: the video the scorer must WATCH
     *  (a Gemini model via @ai-sdk/google), distinct from the text `description`. */
    mediaUrl?: string
    /** The detected Content-Type of `mediaUrl` (e.g. `video/mp4`). */
    mediaType?: string
  }
  ```
- [ ] **Step 4: Run it — expect PASS:** `npx vitest run src/voter/types.test.ts`
- [ ] **Step 5: Typecheck — expect PASS:** `npm run typecheck`
- [ ] **Step 6: Commit:**
  ```sh
  git add src/voter/types.ts src/voter/types.test.ts
  git commit -m "feat(voter): VoterPod gains optional mediaUrl + mediaType for video pods

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 2 — Content-Type detection (HEAD + ranged-GET fallback)

**Files:**
- Create: `src/llm/contentType.ts`
- Test: `src/llm/contentType.test.ts` (create)

- [ ] **Step 1: Write the failing test.** Create `src/llm/contentType.test.ts`:
  ```ts
  // src/llm/contentType.test.ts
  import { describe, it, expect, vi } from 'vitest'
  import { detectContentType, isVideoType } from './contentType.js'

  const res = (status: number, headers: Record<string, string>): Response =>
    new Response(null, { status, headers })

  describe('isVideoType', () => {
    it('true for video/*, false otherwise', () => {
      expect(isVideoType('video/mp4')).toBe(true)
      expect(isVideoType('VIDEO/MP4; codecs=avc1')).toBe(true)
      expect(isVideoType('application/json')).toBe(false)
      expect(isVideoType(undefined)).toBe(false)
    })
  })

  describe('detectContentType', () => {
    it('reads Content-Type + Content-Length from a HEAD', async () => {
      const fetchImpl = vi.fn(async () => res(200, { 'content-type': 'video/mp4', 'content-length': '1234' }))
      const out = await detectContentType('https://x/clip.mp4', fetchImpl)
      expect(fetchImpl).toHaveBeenCalledWith('https://x/clip.mp4', expect.objectContaining({ method: 'HEAD' }))
      expect(out).toEqual({ mediaType: 'video/mp4', contentLength: 1234 })
    })

    it('falls back to a ranged GET when HEAD is rejected (405)', async () => {
      const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) =>
        init?.method === 'HEAD'
          ? res(405, {})
          : res(206, { 'content-type': 'video/webm', 'content-range': 'bytes 0-0/5000' }))
      const out = await detectContentType('https://x/clip', fetchImpl)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(out).toEqual({ mediaType: 'video/webm', contentLength: 5000 })
    })

    it('returns the type with contentLength=null when size is unknown', async () => {
      const fetchImpl = vi.fn(async () => res(200, { 'content-type': 'video/mp4' }))
      expect(await detectContentType('https://x/clip.mp4', fetchImpl)).toEqual({ mediaType: 'video/mp4', contentLength: null })
    })

    it('returns null when both probes fail', async () => {
      const fetchImpl = vi.fn(async () => { throw new Error('network') })
      expect(await detectContentType('https://x/clip', fetchImpl)).toBeNull()
    })
  })
  ```
- [ ] **Step 2: Run it — expect FAIL** (module `./contentType.js` not found):
  `npx vitest run src/llm/contentType.test.ts`
- [ ] **Step 3: Minimal implementation.** Create `src/llm/contentType.ts`:
  ```ts
  // src/llm/contentType.ts — probe a URL's Content-Type (and size) cheaply, so the
  // pod-enrichment loop can route a video pod to the video path WITHOUT downloading it.
  export interface ContentTypeInfo {
    /** lowercase media type, e.g. `video/mp4` (params stripped). */
    mediaType: string
    /** byte length when the server reports it; null when unknown. */
    contentLength: number | null
  }

  type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

  /** True iff `mediaType` is a `video/*` type (case-insensitive, params ignored). */
  export function isVideoType(mediaType: string | undefined | null): boolean {
    return !!mediaType && /^video\//i.test(mediaType.trim())
  }

  function parseType(res: Response): string | null {
    const ct = res.headers.get('content-type')
    return ct ? ct.split(';')[0].trim().toLowerCase() : null
  }

  function parseLength(res: Response): number | null {
    const cl = res.headers.get('content-length')
    if (cl && /^\d+$/.test(cl)) return Number(cl)
    // ranged GET: Content-Range: bytes 0-0/<total>
    const cr = res.headers.get('content-range')
    const m = cr?.match(/\/(\d+)\s*$/)
    return m ? Number(m[1]) : null
  }

  /** HEAD-probe `url` for its Content-Type + size; fall back to a 1-byte ranged GET
   *  when HEAD is unsupported. Returns null on total failure (caller treats as text). */
  export async function detectContentType(
    url: string,
    fetchImpl: FetchImpl = fetch,
  ): Promise<ContentTypeInfo | null> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 15_000)
    try {
      try {
        const head = await fetchImpl(url, { method: 'HEAD', signal: ctrl.signal })
        if (head.ok) {
          const mediaType = parseType(head)
          if (mediaType) return { mediaType, contentLength: parseLength(head) }
        }
      } catch {
        // fall through to the ranged GET
      }
      const ranged = await fetchImpl(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: ctrl.signal })
      if (!ranged.ok && ranged.status !== 206) return null
      const mediaType = parseType(ranged)
      return mediaType ? { mediaType, contentLength: parseLength(ranged) } : null
    } catch {
      return null
    } finally {
      clearTimeout(t)
    }
  }
  ```
- [ ] **Step 4: Run it — expect PASS:** `npx vitest run src/llm/contentType.test.ts`
- [ ] **Step 5: Typecheck — expect PASS:** `npm run typecheck`
- [ ] **Step 6: Commit:**
  ```sh
  git add src/llm/contentType.ts src/llm/contentType.test.ts
  git commit -m "feat(llm): detectContentType (HEAD + ranged-GET fallback) + isVideoType

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 3 — Size-branched video ingest (inline base64 vs Gemini Files API)

**Files:**
- Create: `src/llm/videoIngest.ts`
- Test: `src/llm/videoIngest.test.ts` (create)

> The AI SDK (`@ai-sdk/google@1.2.22`) converts a user-message `FilePart` (`{ type:'file', data, mimeType }`) to a Gemini part by branching on `data`:
> `data instanceof URL` → `fileData: { fileUri, mimeType }` (Files API); else (base64 string / Uint8Array) → `inlineData: { data, mimeType }`. So both branches return the SAME `FilePart` shape — only `data` differs. The SDK has NO upload helper; the Files API upload/poll/delete is REST we own here.

- [ ] **Step 1: Write the failing test.** Create `src/llm/videoIngest.test.ts`:
  ```ts
  // src/llm/videoIngest.test.ts
  import { describe, it, expect, vi } from 'vitest'
  import { ingestVideo, VIDEO_INLINE_MAX_BYTES, VIDEO_MAX_BYTES } from './videoIngest.js'

  const bytesRes = (n: number, type = 'video/mp4'): Response =>
    new Response(new Uint8Array(n), { status: 200, headers: { 'content-type': type } })

  describe('ingestVideo — size branch', () => {
    it('inline: small video → a base64 string FilePart (no Files API call)', async () => {
      const fetchImpl = vi.fn(async () => bytesRes(10))
      const out = await ingestVideo({ url: 'https://x/s.mp4', mediaType: 'video/mp4', contentLength: 10, googleKey: 'k', fetchImpl })
      expect('part' in out).toBe(true)
      if ('part' in out) {
        expect(out.part.type).toBe('file')
        expect(out.part.mimeType).toBe('video/mp4')
        expect(typeof out.part.data).toBe('string') // base64 inline
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1) // only the byte fetch — no upload
    })

    it('over the hard cap → skip-with-reason, never fetched whole', async () => {
      const fetchImpl = vi.fn(async () => bytesRes(1))
      const out = await ingestVideo({ url: 'https://x/big.mp4', mediaType: 'video/mp4', contentLength: VIDEO_MAX_BYTES + 1, googleKey: 'k', fetchImpl })
      expect(out).toEqual({ skip: expect.stringContaining('exceeds') })
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('missing google key → skip-with-reason', async () => {
      const out = await ingestVideo({ url: 'https://x/s.mp4', mediaType: 'video/mp4', contentLength: 10, googleKey: undefined, fetchImpl: vi.fn() })
      expect(out).toEqual({ skip: expect.stringContaining('Google API key') })
    })

    it('large video → Files API: upload, poll ACTIVE, reference by URL, then delete', async () => {
      const size = VIDEO_INLINE_MAX_BYTES + 1
      const fileUri = 'https://generativelanguage.googleapis.com/v1beta/files/abc'
      const calls: string[] = []
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push(`${method} ${url}`)
        if (url === 'https://x/big.mp4') return bytesRes(size)
        if (url.includes('/upload/v1beta/files')) return new Response(JSON.stringify({ file: { name: 'files/abc', uri: fileUri, state: 'PROCESSING' } }), { status: 200 })
        if (method === 'GET' && url.endsWith('/files/abc')) return new Response(JSON.stringify({ name: 'files/abc', uri: fileUri, state: 'ACTIVE' }), { status: 200 })
        if (method === 'DELETE') return new Response(null, { status: 200 })
        throw new Error(`unexpected ${method} ${url}`)
      })
      const out = await ingestVideo({ url: 'https://x/big.mp4', mediaType: 'video/mp4', contentLength: size, googleKey: 'k', fetchImpl, pollIntervalMs: 0 })
      expect('part' in out).toBe(true)
      if ('part' in out) {
        expect(out.part.data).toBeInstanceOf(URL)
        expect(String(out.part.data)).toBe(fileUri)
      }
      expect(calls.some((c) => c.startsWith('DELETE'))).toBe(true) // dereferenced after
    })

    it('Files API upload error → skip-with-reason', async () => {
      const size = VIDEO_INLINE_MAX_BYTES + 1
      const fetchImpl = vi.fn(async (url: string) =>
        url === 'https://x/big.mp4' ? bytesRes(size) : new Response('nope', { status: 500 }))
      const out = await ingestVideo({ url: 'https://x/big.mp4', mediaType: 'video/mp4', contentLength: size, googleKey: 'k', fetchImpl, pollIntervalMs: 0 })
      expect(out).toEqual({ skip: expect.stringContaining('Files API') })
    })

    it('Files API never reaches ACTIVE (FAILED) → skip-with-reason', async () => {
      const size = VIDEO_INLINE_MAX_BYTES + 1
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://x/big.mp4') return bytesRes(size)
        if (url.includes('/upload/v1beta/files')) return new Response(JSON.stringify({ file: { name: 'files/x', uri: 'u', state: 'PROCESSING' } }), { status: 200 })
        if ((init?.method ?? 'GET') === 'DELETE') return new Response(null, { status: 200 })
        return new Response(JSON.stringify({ name: 'files/x', uri: 'u', state: 'FAILED' }), { status: 200 })
      })
      const out = await ingestVideo({ url: 'https://x/big.mp4', mediaType: 'video/mp4', contentLength: size, googleKey: 'k', fetchImpl, pollIntervalMs: 0, maxPolls: 2 })
      expect(out).toEqual({ skip: expect.stringContaining('ACTIVE') })
    })
  })
  ```
- [ ] **Step 2: Run it — expect FAIL** (module `./videoIngest.js` not found):
  `npx vitest run src/llm/videoIngest.test.ts`
- [ ] **Step 3: Minimal implementation.** Create `src/llm/videoIngest.ts`:
  ```ts
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
    let bytes: Uint8Array
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 60_000)
      try {
        const res = await fetchImpl(args.url, { signal: ctrl.signal })
        if (!res.ok) return { skip: `video fetch failed (HTTP ${res.status})` }
        bytes = new Uint8Array(await res.arrayBuffer())
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
        body: bytes,
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
  ```
- [ ] **Step 4: Run it — expect PASS:** `npx vitest run src/llm/videoIngest.test.ts`
- [ ] **Step 5: Typecheck — expect PASS:** `npm run typecheck`
- [ ] **Step 6: Commit:**
  ```sh
  git add src/llm/videoIngest.ts src/llm/videoIngest.test.ts
  git commit -m "feat(llm): size-branched video ingest (inline base64 vs Gemini Files API)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 4 — `generateObjectWithRetry` accepts `messages` in addition to `prompt`

**Files:**
- Modify: `src/llm/generate.ts` (whole function, lines 8–24)
- Test: `src/llm/generate.test.ts` (create)

- [ ] **Step 1: Write the failing test.** Create `src/llm/generate.test.ts`:
  ```ts
  // src/llm/generate.test.ts
  import { describe, it, expect, vi, beforeEach } from 'vitest'
  import { z } from 'zod'
  import type { CoreMessage, LanguageModel } from 'ai'

  const h = vi.hoisted(() => ({ generateObject: vi.fn() }))
  vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateObject: h.generateObject }))

  import { generateObjectWithRetry } from './generate.js'

  const schema = z.object({ n: z.number() })
  const model = {} as LanguageModel

  beforeEach(() => h.generateObject.mockReset())

  describe('generateObjectWithRetry', () => {
    it('prompt path passes { system, prompt } and returns the object', async () => {
      h.generateObject.mockResolvedValueOnce({ object: { n: 1 } })
      const out = await generateObjectWithRetry(model, schema, 'sys', { prompt: 'hello' })
      expect(out).toEqual({ n: 1 })
      expect(h.generateObject).toHaveBeenCalledWith(expect.objectContaining({ model, schema, mode: 'tool', system: 'sys', prompt: 'hello' }))
    })

    it('messages path passes { system, messages } (no prompt)', async () => {
      const messages: CoreMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
      h.generateObject.mockResolvedValueOnce({ object: { n: 2 } })
      const out = await generateObjectWithRetry(model, schema, 'sys', { messages })
      expect(out).toEqual({ n: 2 })
      const call = h.generateObject.mock.calls[0][0]
      expect(call.messages).toBe(messages)
      expect(call.prompt).toBeUndefined()
    })

    it('retries once then throws on a persistently non-conforming response', async () => {
      h.generateObject.mockRejectedValue(new Error('did not match schema'))
      await expect(generateObjectWithRetry(model, schema, 'sys', { prompt: 'x' })).rejects.toThrow('did not match schema')
      expect(h.generateObject).toHaveBeenCalledTimes(2)
    })
  })
  ```
- [ ] **Step 2: Run it — expect FAIL** (current signature is `(model, schema, system, prompt: string)`; passing an object `{ prompt }` is a type error and the call shape mismatches):
  `npx vitest run src/llm/generate.test.ts`
- [ ] **Step 3: Minimal implementation.** Replace the whole body of `src/llm/generate.ts`:
  ```ts
  // src/llm/generate.ts — shared structured-generation helper.
  // generateObject in tool mode with a single retry on a non-conforming response
  // ("No object generated: response did not match schema" is a transient the model
  // usually fixes on the second try). Used by the voter scorer and the panel.
  //
  // Input is EITHER a text `prompt` (text pods, the original path — byte-for-byte
  // unchanged on the wire) OR `messages` (multimodal: a video pod's rubric text +
  // FilePart). Exactly one is required.
  import { generateObject, type CoreMessage, type LanguageModel } from 'ai'
  import type { ZodType } from 'zod'

  export type GenerateInput = { prompt: string } | { messages: CoreMessage[] }

  export async function generateObjectWithRetry<T>(
    model: LanguageModel,
    schema: ZodType<T>,
    system: string,
    input: GenerateInput,
  ): Promise<T> {
    const payload = 'prompt' in input ? { prompt: input.prompt } : { messages: input.messages }
    let lastErr: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { object } = await generateObject({ model, schema, mode: 'tool', system, ...payload })
        return object
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
  ```
- [ ] **Step 4: Run it — expect PASS:** `npx vitest run src/llm/generate.test.ts`
- [ ] **Step 5: Run the dependent existing tests** (panel + voter use `generateObjectWithRetry`) — they will FAIL because they still pass a string 4th arg. **Update callers in this task** before they break the suite:
  `npx vitest run src/voter src/panel 2>&1 | tail -20`  (expect FAIL on call-shape)
- [ ] **Step 6: Update the non-test callers.** Enumerate them:
  `grep -rn "generateObjectWithRetry(" src/ | grep -v ".test.ts"`
  For each (the panel scorers and `src/voter/score.ts` — the latter is rewritten wholesale in Task 5, so update only the panel call sites here), change `generateObjectWithRetry(model, schema, system, prompt)` to `generateObjectWithRetry(model, schema, system, { prompt })`.
- [ ] **Step 7: Typecheck + panel/llm run — expect PASS:** `npm run typecheck && npx vitest run src/panel src/llm`
- [ ] **Step 8: Commit:**
  ```sh
  git add src/llm/generate.ts src/llm/generate.test.ts src/panel
  git commit -m "feat(llm): generateObjectWithRetry accepts messages | prompt input

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 5 — `buildVotePrompt` + `createLlmScorer` go multimodal for video pods

**Files:**
- Modify: `src/voter/score.ts` (`buildVotePrompt` lines 19–29; `createLlmScorer` lines 33–45)
- Test: `src/voter/score.test.ts` (add video cases; keep existing)

> `createLlmScorer` resolves a per-pod model via Phase A's `resolveScoringModel` and ingests the video via Task 3's `ingestVideo`. It needs the registry + default provider/model + the per-datanet `policyModel` — threaded from the wiring in Task 6. The scorer signals an un-scoreable pod by THROWING (so `selectVotes`' existing per-pod `try/catch` at `src/voter/select.ts:38` records the skip), with the resolver's/ingest's reason as the message.

- [ ] **Step 1: Write the failing test.** Append to `src/voter/score.test.ts` (keep the existing `describe`):
  ```ts
  import type { FilePart } from 'ai'

  describe('buildVotePrompt — multimodal video pods', () => {
    const r = { name: 'D', goal: 'g', voterRubric: 'v' } as DatanetRubric
    const videoPart: FilePart = { type: 'file', data: 'BASE64', mimeType: 'video/mp4' }

    it('returns messages (rubric text + video FilePart + instruction) for a video pod', () => {
      const pod = { podId: '1', validityEpoch: '1', name: 'clip', description: '', mediaUrl: 'https://x/c.mp4', mediaType: 'video/mp4' }
      const out = buildVotePrompt(pod, r, 'be strict', videoPart)
      expect('messages' in out).toBe(true)
      if ('messages' in out) {
        const content = out.messages[0].content as Array<{ type: string }>
        expect(out.messages[0].role).toBe('user')
        expect(content.some((p) => p.type === 'text')).toBe(true)
        expect(content.some((p) => p.type === 'file')).toBe(true)
        // rubric + brief still travel in the text part
        const text = (content.find((p) => p.type === 'text') as { text: string }).text
        expect(text).toContain('be strict')
        expect(text).toContain('score') // the 1-10 instruction
      }
    })

    it('still returns a string prompt for a text pod (no video part)', () => {
      const pod = { podId: '2', validityEpoch: '1', name: 't', description: 'd' }
      const out = buildVotePrompt(pod, r, '')
      expect('prompt' in out).toBe(true)
    })
  })
  ```
- [ ] **Step 2: Run it — expect FAIL** (`buildVotePrompt` has 3 params and always returns `{ system, prompt }`):
  `npx vitest run src/voter/score.test.ts`
- [ ] **Step 3: Minimal implementation.** Replace the imports + `buildVotePrompt` + `createLlmScorer` in `src/voter/score.ts`:
  ```ts
  // src/voter/score.ts
  import { z } from 'zod'
  import type { CoreMessage, FilePart, LanguageModel } from 'ai'
  import type { PodScorer, PodScore, VoterPod } from './types.js'
  import type { DatanetRubric } from '../rubric/types.js'
  import type { LlmProvider } from '../llm/model.js'
  import { INJECTION_GUARD, buildRubricBlock } from '../llm/prompt.js'
  import { generateObjectWithRetry } from '../llm/generate.js'
  import { resolveScoringModel } from '../llm/resolveScoringModel.js'
  import { ingestVideo } from '../llm/videoIngest.js'

  const ScoreSchema = z.object({
    score: z.number().int().min(1).max(10),
    // Generous cap: capable models routinely write ~280+ char reasons, and an over-tight
    // bound made every score fail validation ("response did not match schema"). The reason
    // is only logged, so a roomy limit just prevents pathological runaway.
    reason: z.string().max(600),
  })

  const SYSTEM =
    'You are a Reppo datanet voter. Score the pod 1-10 STRICTLY by the datanet rubric below. ' +
    INJECTION_GUARD

  /** Pure: build the input the voter scores a pod with. A TEXT pod → `{ system, prompt }`
   *  (string, unchanged). A VIDEO pod (videoPart supplied) → `{ system, messages }`: a
   *  single user message of [rubric+brief text, the video FilePart, the 1-10 instruction].
   *  brief = optional per-operator strategy injected so the operator's stance shapes curation. */
  export function buildVotePrompt(
    pod: VoterPod,
    rubric: DatanetRubric,
    brief = '',
    videoPart?: FilePart,
  ): { system: string; prompt: string } | { system: string; messages: CoreMessage[] } {
    const briefBlock = brief.trim() ? `\n## Operator strategy (your stance)\n${brief.trim()}\n` : ''
    if (videoPart) {
      const text =
        `${buildRubricBlock(rubric)}\n` +
        `${briefBlock}\n# Pod under review (untrusted)\n## Name\n${pod.name}\n\n` +
        `The attached video is the pod's dataset. Watch it and score 1-10 STRICTLY by the rubric. ` +
        `Return a 1-10 score and a one-line reason citing the rubric.`
      const messages: CoreMessage[] = [
        { role: 'user', content: [{ type: 'text', text }, videoPart] },
      ]
      return { system: SYSTEM, messages }
    }
    const prompt =
      `${buildRubricBlock(rubric)}\n` +
      `${briefBlock}\n# Pod under review (untrusted)\n## Name\n${pod.name}\n## Description\n${pod.description}\n\n` +
      `Return a 1-10 score and a one-line reason citing the rubric.`
    return { system: SYSTEM, prompt }
  }

  /** Inputs needed to resolve a per-pod scoring model (Phase A) + ingest video. Passed
   *  by the wiring; absent ctx ⇒ text-only behavior on the node-default model. */
  export interface ScorerModelCtx {
    registry: Map<LlmProvider, string>
    defaultProvider: LlmProvider
    defaultModel: string
    /** the datanet's optional { provider, model } override (config.datanets[id].model). */
    policyModel?: { provider: LlmProvider; model: string }
  }

  /** LLM-backed scorer. `opts.brief` personalizes scoring with the operator's stance;
   *  pass a function to read the brief live (so dashboard notes edits hot-reload).
   *  When `opts.modelCtx` is supplied, the model is resolved PER POD (Phase A) and a
   *  video pod is watched via @ai-sdk/google; without it the fixed `model` scores text. */
  export function createLlmScorer(
    model: LanguageModel,
    opts: { brief?: string | (() => string); modelCtx?: ScorerModelCtx | (() => ScorerModelCtx) } = {},
  ): PodScorer {
    const resolveBrief = () => (typeof opts.brief === 'function' ? opts.brief() : opts.brief ?? '')
    const resolveCtx = () => (typeof opts.modelCtx === 'function' ? opts.modelCtx() : opts.modelCtx)
    return {
      async scorePod(pod: VoterPod, rubric: DatanetRubric): Promise<PodScore> {
        const isVideo = !!pod.mediaUrl
        const ctx = resolveCtx()
        // Text pod with no per-pod ctx → the original fixed-model text path, unchanged.
        if (!isVideo && !ctx) {
          const built = buildVotePrompt(pod, rubric, resolveBrief())
          return generateObjectWithRetry(model, ScoreSchema, built.system, { prompt: (built as { prompt: string }).prompt })
        }
        // Resolve the scoring model per pod (explicit override → video default → node
        // default). A skip reason THROWS so selectVotes' per-pod try/catch records it.
        const resolved = ctx
          ? resolveScoringModel({
              policyModel: ctx.policyModel,
              isVideo,
              registry: ctx.registry,
              defaultProvider: ctx.defaultProvider,
              defaultModel: ctx.defaultModel,
            })
          : { model }
        if ('skip' in resolved) throw new Error(resolved.skip)
        if (!isVideo) {
          const built = buildVotePrompt(pod, rubric, resolveBrief())
          return generateObjectWithRetry(resolved.model, ScoreSchema, built.system, { prompt: (built as { prompt: string }).prompt })
        }
        // Video pod: ingest (size-branched) → FilePart, build messages, score.
        const ingest = await ingestVideo({
          url: pod.mediaUrl as string,
          mediaType: pod.mediaType ?? 'video/mp4',
          contentLength: null, // ingestVideo re-measures + re-enforces VIDEO_MAX_BYTES from the byte fetch
          googleKey: ctx?.registry.get('google'),
        })
        if ('skip' in ingest) throw new Error(ingest.skip)
        const built = buildVotePrompt(pod, rubric, resolveBrief(), ingest.part)
        return generateObjectWithRetry(resolved.model, ScoreSchema, built.system, { messages: (built as { messages: CoreMessage[] }).messages })
      },
    }
  }
  ```
  > **Note on `contentLength: null`:** detection (Task 2) records the size, but `VoterPod` carries only `mediaUrl`/`mediaType` (datanet-agnostic). `ingestVideo` re-measures from the byte fetch and re-enforces `VIDEO_MAX_BYTES`, so the hard cap still holds. An optional follow-up could thread the detected length onto the pod; it is not required for correctness.
- [ ] **Step 4: Run it — expect PASS:** `npx vitest run src/voter/score.test.ts`
- [ ] **Step 5: Run the voter suite (regression — text path) — expect PASS:** `npx vitest run src/voter`
- [ ] **Step 6: Typecheck — expect PASS:** `npm run typecheck`
- [ ] **Step 7: Commit:**
  ```sh
  git add src/voter/score.ts src/voter/score.test.ts
  git commit -m "feat(voter): buildVotePrompt returns multimodal messages for video pods; per-pod model resolution + ingest

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 6 — Wire detection + the registry/cap into the enrichment loop

**Files:**
- Modify: `src/runtime/wiring.ts` (`WiringIo`/`defaultIo` lines 61–74; `CycleWiring` interface lines 76–97; `buildCycleDeps` closures lines 106–120; the enrichment loop lines 160–163)
- Test: `src/runtime/wiring.test.ts` (add video-detection + cap cases; keep existing; extend the `wiring()` fixture)

> The wiring already threads `w.config` + `w.model`. Phase B adds: the provider key registry, the default provider/model, the per-cycle video cap, and a `detectType` IO seam. `selectVotes` calls ONE shared `voteScorer` across datanets, so the per-datanet `model` override is exposed to the scorer via a closure variable (`activeDatanetId`) set at the top of `getPodsAndFilter` and read by the scorer's `modelCtx` getter.

- [ ] **Step 1: Write the failing test.** Append to `src/runtime/wiring.test.ts` inside `describe('buildCycleDeps', ...)`:
  ```ts
  it('detects a video pod: sets mediaUrl/mediaType and does NOT text-enrich it', async () => {
    const w = wiring()
    const detectType = vi.fn(async (url: string) =>
      url.endsWith('.mp4') ? { mediaType: 'video/mp4', contentLength: 1000 } : null)
    const fetchContent = vi.fn(async () => 'TEXT')
    const deps = buildCycleDeps({
      ...w,
      registry: new Map([['google', 'gk']]),
      defaultProvider: 'virtuals',
      defaultModel: 'claude-opus-4-8',
      io: {
        listPods: async (_id, opts) => opts.all
          ? [pod('vid', { url: 'https://x/clip.mp4' }), pod('txt', { url: 'https://x/doc.json' })]
          : [],
        fetchContent,
        detectType,
      },
    })
    const { pods } = await deps.getPodsAndFilter('2')
    const vid = pods.find((p) => p.podId === 'vid')!
    const txt = pods.find((p) => p.podId === 'txt')!
    expect(vid.mediaUrl).toBe('https://x/clip.mp4')
    expect(vid.mediaType).toBe('video/mp4')
    expect(fetchContent).toHaveBeenCalledTimes(1)            // only the text pod
    expect(fetchContent).toHaveBeenCalledWith('https://x/doc.json')
    expect(txt.description).toContain('TEXT')
    expect(txt.mediaUrl).toBeUndefined()
  })

  it('caps the number of video pods marked per cycle (videoPodsPerCycle)', async () => {
    const w = wiring()
    const detectType = vi.fn(async () => ({ mediaType: 'video/mp4', contentLength: 1000 }))
    const deps = buildCycleDeps({
      ...w,
      registry: new Map([['google', 'gk']]),
      defaultProvider: 'virtuals',
      defaultModel: 'claude-opus-4-8',
      videoPodsPerCycle: 1,
      io: {
        listPods: async (_id, opts) => opts.all ? [pod('v1', { url: 'https://x/a.mp4' }), pod('v2', { url: 'https://x/b.mp4' })] : [],
        fetchContent: async () => '',
        detectType,
      },
    })
    const { pods } = await deps.getPodsAndFilter('2')
    const marked = pods.filter((p) => p.mediaUrl).length
    expect(marked).toBe(1) // second video pod left unmarked (over the per-cycle cap)
  })
  ```
- [ ] **Step 2: Run it — expect FAIL** (`registry`/`defaultProvider`/`defaultModel`/`videoPodsPerCycle` not on `CycleWiring`; `detectType` not on `WiringIo`; loop never sets `mediaUrl`):
  `npx vitest run src/runtime/wiring.test.ts`
- [ ] **Step 3: Implementation — imports + `WiringIo` + `defaultIo`.** In `src/runtime/wiring.ts`, add imports near the top:
  ```ts
  import type { LlmProvider } from '../llm/model.js'
  import { detectContentType, isVideoType } from '../llm/contentType.js'
  ```
  Replace `import { createLlmScorer } from '../voter/score.js'` with:
  ```ts
  import { createLlmScorer, type ScorerModelCtx } from '../voter/score.js'
  ```
  Extend the `WiringIo` interface (after `fetchContent(url: string): Promise<string>`):
  ```ts
    /** Probe a pod URL's Content-Type so a video pod routes to the video path. */
    detectType(url: string): Promise<{ mediaType: string; contentLength: number | null } | null>
  ```
  Extend `defaultIo` (after `fetchContent: (url) => fetchPodContent(url),`):
  ```ts
    detectType: (url) => detectContentType(url),
  ```
- [ ] **Step 4: Implementation — `CycleWiring` fields.** Add to the `CycleWiring` interface immediately after the `model` field:
  ```ts
    /** Phase A provider key registry (provider → apiKey), built at startup from env. */
    registry: Map<LlmProvider, string>
    /** The node default provider/model (from LLM_PROVIDER/LLM_API_KEY/DEFAULT_MODEL). */
    defaultProvider: LlmProvider
    defaultModel: string
    /** Cost/latency cap: at most this many video pods are marked (and thus scored as
     *  video) per cycle. Over the cap, extra video pods are left unmarked and fall
     *  through unscored this cycle. Default 4. */
    videoPodsPerCycle?: number
  ```
- [ ] **Step 5: Implementation — the model-ctx closure.** In `buildCycleDeps`, just below `const liveBrief = (): string => w.config.notes` (line 106), add:
  ```ts
    // The datanet currently being enriched/scored — set in getPodsAndFilter so the shared
    // voteScorer's modelCtx getter can read THIS datanet's per-datanet model override.
    let activeDatanetId: string | null = null
    const modelCtx = (): ScorerModelCtx => {
      const pm = activeDatanetId
        ? (w.config.datanets[activeDatanetId] as { model?: { provider: LlmProvider; model: string } } | undefined)?.model
        : undefined
      return { registry: w.registry, defaultProvider: w.defaultProvider, defaultModel: w.defaultModel, policyModel: pm }
    }
  ```
  Change the screen scorer construction (line 120) to pass `modelCtx`:
  ```ts
    const screenScorer = createLlmScorer(w.model, { brief: liveBrief, modelCtx })
  ```
- [ ] **Step 6: Implementation — the enrichment loop.** In `getPodsAndFilter`, set the active datanet id at the very top of the `async (id) =>` body (before `const pods = await io.listPods(...)`):
  ```ts
      activeDatanetId = id
  ```
  Replace the enrichment loop at lines 160–163 with:
  ```ts
      // Enrich ONLY pods we might actually vote on (current epoch, not ours, not voted)
      // — content fetches are the slow part of a cycle. For each, probe Content-Type:
      // a video/* pod is marked (mediaUrl/mediaType) for the Gemini video path instead
      // of text-fetched; a per-cycle cap bounds how many videos we score.
      const videoCap = w.videoPodsPerCycle ?? 4
      let videoMarked = 0
      for (const p of pods) {
        const eligible = (currentEpoch === null || p.validityEpoch === currentEpoch) && !ownSet.has(p.podId) && !votedSet.has(p.podId)
        if (!eligible || !p.url) continue
        let info: { mediaType: string; contentLength: number | null } | null = null
        try { info = await io.detectType(p.url) } catch { info = null }
        if (info && isVideoType(info.mediaType) && videoMarked < videoCap) {
          p.mediaUrl = p.url
          p.mediaType = info.mediaType
          videoMarked++
          continue // do NOT text-fetch a video (binary garbage)
        }
        const c = await io.fetchContent(p.url)
        if (c) p.description = `${p.name}\n\n${c}`
      }
  ```
- [ ] **Step 7: Extend the test fixture.** In `src/runtime/wiring.test.ts`, the `wiring()` helper (lines 43–53) must supply the new required fields or every existing test errors on construction. Add to the returned object before `...over`:
  ```ts
    registry: new Map(),
    defaultProvider: 'virtuals',
    defaultModel: 'claude-opus-4-8',
  ```
- [ ] **Step 8: Run the FULL wiring suite — expect PASS:** `npx vitest run src/runtime/wiring.test.ts`
- [ ] **Step 9: Typecheck — expect PASS:** `npm run typecheck`
- [ ] **Step 10: Commit:**
  ```sh
  git add src/runtime/wiring.ts src/runtime/wiring.test.ts
  git commit -m "feat(runtime): probe Content-Type in enrichment, route video pods to Gemini, cap per cycle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 7 — Construct the wiring's new fields in `index.ts` + document env vars

**Files:**
- Modify: `src/index.ts` (the `CycleWiring`/`buildCycleDeps` construction site)
- Modify: `.env.example` (document the new vars after line 27, `LLM_API_KEY`)

> Phase A builds the provider key registry + the default provider/model at startup. This task only THREADS them (plus the optional `videoPodsPerCycle` from env) into the `CycleWiring` object `index.ts` already constructs. Reference Phase A's symbols — do not rebuild the registry here.

- [ ] **Step 1: Locate the construction site.**
  `grep -n "buildCycleDeps\|model:\|CycleWiring\|registry\|defaultProvider" src/index.ts`
- [ ] **Step 2: Thread the fields.** In the `CycleWiring` object literal in `src/index.ts`, add (using Phase A's `registry` + `defaultProvider` + `defaultModel` variables — referenced, not redefined; map the names if Phase A chose different locals):
  ```ts
    registry,
    defaultProvider,
    defaultModel,
    videoPodsPerCycle: process.env.VIDEO_PODS_PER_CYCLE ? Number(process.env.VIDEO_PODS_PER_CYCLE) : undefined,
  ```
- [ ] **Step 3: Typecheck — expect PASS** (this proves the construction satisfies `CycleWiring`):
  `npm run typecheck`
- [ ] **Step 4: Document env vars.** Read `.env.example`, then append after the `LLM_API_KEY` line (line 27):
  ```sh
  # --- Video voting (Phase B) ---
  # A pod whose URL is video/* is scored by a Gemini model (needs LLM_KEY_GOOGLE).
  # Inline-vs-Files-API size threshold (bytes). Below → inline base64 in one request;
  # above → Gemini Files API upload. Default 20 MB.
  VIDEO_INLINE_MAX_BYTES=20971520
  # Hard cap (bytes): a larger video pod is skipped with a recorded reason. Default 200 MB.
  VIDEO_MAX_BYTES=209715200
  # Max video pods scored per cycle (cost/latency cap). Default 4.
  VIDEO_PODS_PER_CYCLE=4
  ```
- [ ] **Step 5: Full test suite — expect PASS:** `npm test`
- [ ] **Step 6: Build (incl. web) — expect PASS:** `npm run build`
- [ ] **Step 7: Commit:**
  ```sh
  git add src/index.ts .env.example
  git commit -m "feat(runtime): thread provider registry + video caps into wiring; document video env vars

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Self-Review

### Spec-coverage checklist (Phase B = §B1–B3 + Failure/limits/Testing)
- [x] **B1 Detect — Content-Type in the enrichment loop (HEAD + ranged-GET fallback), `video/*` → video path.** Task 2 (`detectContentType`/`isVideoType`) + Task 6 (the loop probes each eligible pod, marks `mediaUrl`/`mediaType`, skips the text fetch).
- [x] **B2 Ingest — size-branched: inline base64 under `VIDEO_INLINE_MAX_BYTES`, else Gemini Files API (upload → poll ACTIVE → reference → delete); hard cap `VIDEO_MAX_BYTES` → skip-with-reason, not fetched whole.** Task 3 (`ingestVideo`), mocked-`fetch` tests for every branch incl. over-cap-before-fetch and FAILED-state.
- [x] **B3 — `VoterPod.mediaUrl?`/`mediaType?`.** Task 1.
- [x] **B3 — `buildVotePrompt` returns message parts for video, string for text, keeping `INJECTION_GUARD` + operator brief.** Task 5 (`SYSTEM` keeps `INJECTION_GUARD`; brief in the text part; rubric via `buildRubricBlock`, which carries `RUBRIC_GUARD`).
- [x] **B3 — `generateObjectWithRetry` accepts `messages`/content parts in addition to `prompt`; string path byte-for-byte unchanged.** Task 4 (`payload` spreads `{prompt}` or `{messages}`; same `mode:'tool'`, `system`, retry-once).
- [x] **Wire it: video pod resolves via `resolveScoringModel` (Phase A) → google/Gemini, gets the video part, scores — or skips with reason (no google key / non-Gemini model / over-size / fetch or Gemini error), reusing the per-datanet skip/record mechanism.** Task 5 (scorer calls `resolveScoringModel`, throws the skip reason) + Task 6 (wiring threads ctx). The throw lands in `selectVotes`' existing per-pod `try/catch` (`src/voter/select.ts:38`), which logs + `continue`s — the exact existing skip/record mechanism, never aborting the datanet/cycle.
- [x] **Per-cycle video-pod cap.** Task 6 (`videoPodsPerCycle`, default 4) + Task 7 (env `VIDEO_PODS_PER_CYCLE`).
- [x] **Text path byte-for-byte unchanged.** Task 4 keeps the `prompt` wire shape; Task 5 keeps the text branch's prompt string identical (same `buildRubricBlock` + brief + name/description ordering) and routes text pods with no ctx through the original fixed-model call; Task 6 only adds a probe + branch around the existing `fetchContent`/`description` write. Regression covered by re-running `src/voter` + the existing `score.test.ts`/`wiring.test.ts` cases.
- [x] **Spec Testing rows** — Content-Type routes video→video path (Task 2/6); inline-vs-Files-API by size, mocked (Task 3); `buildVotePrompt` message parts for video, string for text (Task 5); skip-with-reason on over-size / fetch fail / Gemini error (Task 3 + Task 5); existing text voter tests stay green (Task 5 Step 5, Task 6 Step 8).

### Placeholder scan
- No `TBD`, no "add error handling", no "similar to Task N", no "etc." in any code/test step. Every `Create`/`Modify` step contains the literal TS (ESM, `.js` import extensions, Zod, colocated vitest). The narrative "Note" / "map the names if Phase A chose different locals" lines are guidance ADJACENT to complete, runnable code blocks — not stand-ins for code.

### Type-consistency check (against the SHARED TYPE CONTRACT)
- `VoterPod.mediaUrl?: string` + `mediaType?: string` — Task 1, exact names/shapes. ✔
- `buildVotePrompt` returns message parts for video, string for text — Task 5 returns `{ system, messages: CoreMessage[] }` (user message `content: [TextPart, FilePart]`) vs `{ system, prompt: string }`. ✔
- `generateObjectWithRetry` accepts `messages`/`ContentPart[]` in addition to `prompt` — Task 4 `GenerateInput = { prompt } | { messages: CoreMessage[] }` (the SDK's `UserContent = string | Array<TextPart | ImagePart | FilePart>` carries the content parts inside the message). ✔
- **Phase A referenced, not redefined:** `resolveScoringModel({ policyModel, isVideo, registry, defaultProvider, defaultModel })` → `{ model } | { skip }` is IMPORTED (`src/llm/resolveScoringModel.js`) and CALLED in Task 5; the registry `Map<LlmProvider, string>`, `defaultProvider`, `defaultModel`, and `config.datanets[id].model` are CONSUMED (Task 6/7), never declared. `LlmProvider` is imported from the existing `src/llm/model.ts`. No `DatanetPolicy.model`, no `LlmProviderEnum`, no registry construction is (re)defined here. ✔
- `FilePart` (`{ type:'file', data: DataContent | URL, mimeType: string }`), `CoreMessage`, `UserContent`, `generateObject({ messages })` all verified present in the installed `ai@4.3.19` types; `@ai-sdk/google@1.2.22` converts a `file` part to `inlineData` (base64 `data`) or `fileData` (URL `data`) — the size branch is the same `FilePart`, only `data` differs. ✔
