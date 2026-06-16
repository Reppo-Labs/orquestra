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
