// src/llm/videoIngest.test.ts
import { describe, it, expect, vi } from 'vitest'
import { ingestVideo, VIDEO_INLINE_MAX_BYTES, VIDEO_MAX_BYTES } from './videoIngest.js'

const bytesRes = (n: number, type = 'video/mp4'): Response =>
  new Response(new Uint8Array(n), { status: 200, headers: { 'content-type': type } })

// Raw size that base64-encodes to JUST OVER the inline limit (so it must take the Files API)
// while the raw bytes are still UNDER the limit — the base64-inflation boundary.
const INLINE_RAW_MAX = Math.floor((VIDEO_INLINE_MAX_BYTES * 3) / 4)

describe('ingestVideo — size branch', () => {
  it('inline: small video → a base64 string FilePart (no Files API call, no cleanup)', async () => {
    const fetchImpl = vi.fn(async () => bytesRes(10))
    const out = await ingestVideo({ url: 'https://x/s.mp4', mediaType: 'video/mp4', contentLength: 10, googleKey: 'k', fetchImpl })
    expect('part' in out).toBe(true)
    if ('part' in out) {
      expect(out.part.type).toBe('file')
      expect(out.part.mimeType).toBe('video/mp4')
      expect(typeof out.part.data).toBe('string') // base64 inline
      expect(out.cleanup).toBeUndefined()          // inline has nothing to clean up
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

  it('base64-inflation boundary: raw under the inline limit but base64-encoded OVER it → Files API path', async () => {
    // raw <= VIDEO_INLINE_MAX_BYTES but ENCODED (raw * 4/3) > VIDEO_INLINE_MAX_BYTES.
    const raw = INLINE_RAW_MAX + 1 // raw < VIDEO_INLINE_MAX_BYTES, encoded just over
    expect(raw).toBeLessThan(VIDEO_INLINE_MAX_BYTES) // truly under the raw 20MB limit
    const fileUri = 'https://generativelanguage.googleapis.com/v1beta/files/inf'
    let uploaded = false
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === 'https://x/edge.mp4') return bytesRes(raw)
      if (url.includes('/upload/v1beta/files')) { uploaded = true; return new Response(JSON.stringify({ file: { name: 'files/inf', uri: fileUri, state: 'ACTIVE' } }), { status: 200 }) }
      if (method === 'GET' && url.includes('/files/inf')) return new Response(JSON.stringify({ uri: fileUri, state: 'ACTIVE' }), { status: 200 })
      if (method === 'DELETE') return new Response(null, { status: 200 })
      throw new Error(`unexpected ${method} ${url}`)
    })
    const out = await ingestVideo({ url: 'https://x/edge.mp4', mediaType: 'video/mp4', contentLength: raw, googleKey: 'k', fetchImpl, pollIntervalMs: 0 })
    expect(uploaded).toBe(true) // took the Files API path, NOT inline
    expect('part' in out && out.part.data instanceof URL).toBe(true)
  })

  it('large video → Files API: upload, poll ACTIVE, reference by URL; cleanup deletes (NOT before return)', async () => {
    const size = VIDEO_INLINE_MAX_BYTES + 1
    const fileUri = 'https://generativelanguage.googleapis.com/v1beta/files/abc'
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      if (url === 'https://x/big.mp4') return bytesRes(size)
      if (url.includes('/upload/v1beta/files')) return new Response(JSON.stringify({ file: { name: 'files/abc', uri: fileUri, state: 'PROCESSING' } }), { status: 200 })
      // The status poll appends `?key=` (Gemini REST auth), so match by includes, not endsWith.
      if (method === 'GET' && url.includes('/files/abc')) return new Response(JSON.stringify({ name: 'files/abc', uri: fileUri, state: 'ACTIVE' }), { status: 200 })
      if (method === 'DELETE') return new Response(null, { status: 200 })
      throw new Error(`unexpected ${method} ${url}`)
    })
    const out = await ingestVideo({ url: 'https://x/big.mp4', mediaType: 'video/mp4', contentLength: size, googleKey: 'k', fetchImpl, pollIntervalMs: 0 })
    expect('part' in out).toBe(true)
    if ('part' in out) {
      expect(out.part.data).toBeInstanceOf(URL)
      expect(String(out.part.data)).toBe(fileUri)
      // CRITICAL: the file must NOT be deleted before ingestVideo returns — the model still
      // needs to read the fileData URI. Delete only happens when the caller runs cleanup.
      expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false)
      expect(typeof out.cleanup).toBe('function')
      await out.cleanup!()
      expect(calls.some((c) => c.startsWith('DELETE'))).toBe(true) // now it deletes
    }
  })

  it('Files API upload error → skip-with-reason (no file to clean up)', async () => {
    const size = VIDEO_INLINE_MAX_BYTES + 1
    const fetchImpl = vi.fn(async (url: string) =>
      url === 'https://x/big.mp4' ? bytesRes(size) : new Response('nope', { status: 500 }))
    const out = await ingestVideo({ url: 'https://x/big.mp4', mediaType: 'video/mp4', contentLength: size, googleKey: 'k', fetchImpl, pollIntervalMs: 0 })
    expect(out).toEqual({ skip: expect.stringContaining('Files API') })
  })

  it('Files API never reaches ACTIVE (FAILED) → skip AND deletes the orphaned upload', async () => {
    const size = VIDEO_INLINE_MAX_BYTES + 1
    let deleted = false
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://x/big.mp4') return bytesRes(size)
      if (url.includes('/upload/v1beta/files')) return new Response(JSON.stringify({ file: { name: 'files/x', uri: 'u', state: 'PROCESSING' } }), { status: 200 })
      if ((init?.method ?? 'GET') === 'DELETE') { deleted = true; return new Response(null, { status: 200 }) }
      return new Response(JSON.stringify({ name: 'files/x', uri: 'u', state: 'FAILED' }), { status: 200 })
    })
    const out = await ingestVideo({ url: 'https://x/big.mp4', mediaType: 'video/mp4', contentLength: size, googleKey: 'k', fetchImpl, pollIntervalMs: 0, maxPolls: 2 })
    expect(out).toEqual({ skip: expect.stringContaining('ACTIVE') })
    expect(deleted).toBe(true) // post-upload skip cleaned up the orphan
  })

  it('status-poll HTTP failure AFTER upload → skip AND deletes the orphaned upload', async () => {
    const size = VIDEO_INLINE_MAX_BYTES + 1
    let deleted = false
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === 'https://x/big.mp4') return bytesRes(size)
      if (url.includes('/upload/v1beta/files')) return new Response(JSON.stringify({ file: { name: 'files/y', uri: 'u', state: 'PROCESSING' } }), { status: 200 })
      if (method === 'DELETE') { deleted = true; return new Response(null, { status: 200 }) }
      if (method === 'GET') return new Response('boom', { status: 503 }) // status poll fails
      throw new Error(`unexpected ${method} ${url}`)
    })
    const out = await ingestVideo({ url: 'https://x/big.mp4', mediaType: 'video/mp4', contentLength: size, googleKey: 'k', fetchImpl, pollIntervalMs: 0, maxPolls: 5 })
    expect('skip' in out && /status failed/.test(out.skip)).toBe(true)
    expect(deleted).toBe(true)
  })

  it('upload returned a name but NO uri AFTER upload → skip AND deletes the orphan', async () => {
    const size = VIDEO_INLINE_MAX_BYTES + 1
    let deleted = false
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === 'https://x/big.mp4') return bytesRes(size)
      if (url.includes('/upload/v1beta/files')) return new Response(JSON.stringify({ file: { name: 'files/z', state: 'PROCESSING' } }), { status: 200 }) // no uri
      if (method === 'DELETE') { deleted = true; return new Response(null, { status: 200 }) }
      throw new Error(`unexpected ${method} ${url}`)
    })
    const out = await ingestVideo({ url: 'https://x/big.mp4', mediaType: 'video/mp4', contentLength: size, googleKey: 'k', fetchImpl, pollIntervalMs: 0 })
    expect(out).toEqual({ skip: expect.stringContaining('no file uri') })
    expect(deleted).toBe(true)
  })

  it('a never-resolving status fetch times out → skip, does not hang', async () => {
    const size = VIDEO_INLINE_MAX_BYTES + 1
    let deleted = false
    // The status GET resolves ONLY when the injected AbortSignal aborts (mirrors a hung call);
    // the 15s status-timeout AbortController fires that abort → reject → skip.
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === 'https://x/big.mp4') return Promise.resolve(bytesRes(size))
      if (url.includes('/upload/v1beta/files')) return Promise.resolve(new Response(JSON.stringify({ file: { name: 'files/h', uri: 'u', state: 'PROCESSING' } }), { status: 200 }))
      if (method === 'DELETE') { deleted = true; return Promise.resolve(new Response(null, { status: 200 })) }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    vi.useFakeTimers()
    try {
      const p = ingestVideo({ url: 'https://x/big.mp4', mediaType: 'video/mp4', contentLength: size, googleKey: 'k', fetchImpl, pollIntervalMs: 0, maxPolls: 3 })
      await vi.advanceTimersByTimeAsync(20_000) // past the 15s status timeout
      const out = await p
      expect('skip' in out && /status error/.test(out.skip)).toBe(true)
      expect(deleted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
