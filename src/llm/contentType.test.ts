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

  it('a hung HEAD times out on its OWN budget; the ranged GET fallback still runs and detects', async () => {
    // The HEAD resolves only when its injected signal aborts (mirrors a hung request). With a
    // single shared timer the GET would inherit an already-aborted signal and never detect;
    // with per-request timers the GET gets a fresh window and succeeds.
    const fetchImpl = vi.fn((_u: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      // GET fallback: its signal must NOT be aborted at call time (proves a fresh timer).
      expect(init?.signal?.aborted).toBe(false)
      return Promise.resolve(res(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/9999' }))
    })
    vi.useFakeTimers()
    try {
      const p = detectContentType('https://x/clip.mp4', fetchImpl)
      await vi.advanceTimersByTimeAsync(20_000) // past the 15s HEAD timeout
      const out = await p
      expect(out).toEqual({ mediaType: 'video/mp4', contentLength: 9999 })
    } finally {
      vi.useRealTimers()
    }
  })
})
