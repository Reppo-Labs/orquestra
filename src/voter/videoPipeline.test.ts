// src/voter/videoPipeline.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createVideoPipeline, isVideoPod, type VideoPipelineDeps } from './videoPipeline.js'
import type { VoterPod } from './types.js'
import type { LlmProvider } from '../llm/model.js'

const pod = (over: Partial<VoterPod> = {}): VoterPod =>
  ({ podId: 'p1', validityEpoch: '1', name: 'clip', description: 'clip', ...over })

const reg = (...entries: [LlmProvider, string][]) => new Map<LlmProvider, string>(entries)

function pipeline(over: Partial<VideoPipelineDeps> = {}) {
  return createVideoPipeline({
    registry: reg(['google', 'gk']),
    detectType: async () => ({ mediaType: 'video/mp4', contentLength: 1000 }),
    ...over,
  })
}

describe('isVideoPod', () => {
  it('true iff the pod was marked with a mediaUrl', () => {
    expect(isVideoPod(pod())).toBe(false)
    expect(isVideoPod(pod({ mediaUrl: 'https://x/c.mp4' }))).toBe(true)
  })
})

describe('detectAndMark', () => {
  it('marks a video/* pod (mediaUrl, mediaType, contentLength) and returns true', async () => {
    const p = pod({ url: 'https://x/clip.mp4' })
    expect(await pipeline().detectAndMark(p)).toBe(true)
    expect(p.mediaUrl).toBe('https://x/clip.mp4')
    expect(p.mediaType).toBe('video/mp4')
    expect(p.contentLength).toBe(1000)
  })

  it('returns false for a non-video Content-Type (text path)', async () => {
    const p = pod({ url: 'https://x/doc.json' })
    const v = pipeline({ detectType: async () => ({ mediaType: 'application/json', contentLength: 10 }) })
    expect(await v.detectAndMark(p)).toBe(false)
    expect(p.mediaUrl).toBeUndefined()
  })

  it('returns false when detection fails or returns null (treated as text)', async () => {
    expect(await pipeline({ detectType: async () => null }).detectAndMark(pod({ url: 'https://x/a' }))).toBe(false)
    expect(await pipeline({ detectType: async () => { throw new Error('net down') } }).detectAndMark(pod({ url: 'https://x/a' }))).toBe(false)
  })

  it('returns false without probing when the pod has no url', async () => {
    const detectType = vi.fn(async () => ({ mediaType: 'video/mp4', contentLength: null }))
    expect(await pipeline({ detectType }).detectAndMark(pod())).toBe(false)
    expect(detectType).not.toHaveBeenCalled()
  })

  it('resolves a Google Drive viewer URL to a direct download before probing and marks the RESOLVED url', async () => {
    // The Drive viewer URL serves HTML; only the resolved usercontent download URL probes as video.
    const detectType = vi.fn(async (url: string) =>
      url.startsWith('https://drive.usercontent.google.com/download')
        ? { mediaType: 'video/mp4', contentLength: 1000 }
        : null)
    const p = pod({ url: 'https://drive.google.com/file/d/1AbC_dEfGhI/view?usp=sharing' })
    expect(await pipeline({ detectType }).detectAndMark(p)).toBe(true)
    expect(detectType).toHaveBeenCalledWith('https://drive.usercontent.google.com/download?id=1AbC_dEfGhI&export=download&confirm=t')
    expect(p.mediaUrl).toBe('https://drive.usercontent.google.com/download?id=1AbC_dEfGhI&export=download&confirm=t')
    expect(p.mediaType).toBe('video/mp4')
  })

  it('treats a Drive-resolved URL serving application/octet-stream as video and coerces mediaType to video/mp4', async () => {
    const p = pod({ url: 'https://drive.google.com/file/d/1AbC_dEfGhI/view' })
    const v = pipeline({ detectType: async () => ({ mediaType: 'application/octet-stream', contentLength: 1000 }) })
    expect(await v.detectAndMark(p)).toBe(true)
    expect(p.mediaType).toBe('video/mp4') // coerced: Gemini needs a concrete video mime
  })

  it('does NOT treat a non-Drive URL serving application/octet-stream as video', async () => {
    const p = pod({ url: 'https://cdn.example.com/blob' })
    const v = pipeline({ detectType: async () => ({ mediaType: 'application/octet-stream', contentLength: 1000 }) })
    expect(await v.detectAndMark(p)).toBe(false)
    expect(p.mediaUrl).toBeUndefined()
  })

  it('leaves contentLength unset when detection did not report a size', async () => {
    const p = pod({ url: 'https://x/clip.mp4' })
    const v = pipeline({ detectType: async () => ({ mediaType: 'video/mp4', contentLength: null }) })
    await v.detectAndMark(p)
    expect(p.contentLength).toBeUndefined()
  })
})

describe('detectAndMark per-cycle budget', () => {
  it('over the cap a DETECTED video still returns true (never text-fetched) but is left unmarked', async () => {
    const v = pipeline({ videoPodsPerCycle: 1 })
    const a = pod({ podId: 'a', url: 'https://x/a.mp4' })
    const b = pod({ podId: 'b', url: 'https://x/b.mp4' })
    expect(await v.detectAndMark(a)).toBe(true)
    expect(a.mediaUrl).toBeDefined()
    expect(await v.detectAndMark(b)).toBe(true) // detected video: caller must skip, not text-fetch
    expect(b.mediaUrl).toBeUndefined()          // over budget: unmarked, retried next cycle
  })

  it('beginCycle re-arms the budget', async () => {
    const v = pipeline({ videoPodsPerCycle: 1 })
    await v.detectAndMark(pod({ url: 'https://x/a.mp4' }))
    const late = pod({ podId: 'late', url: 'https://x/b.mp4' })
    await v.detectAndMark(late)
    expect(late.mediaUrl).toBeUndefined()
    v.beginCycle()
    const fresh = pod({ podId: 'fresh', url: 'https://x/c.mp4' })
    await v.detectAndMark(fresh)
    expect(fresh.mediaUrl).toBeDefined()
  })

  it('defaults the cap to 4 per cycle', async () => {
    const v = pipeline()
    let marked = 0
    for (let i = 0; i < 6; i++) {
      const p = pod({ podId: `p${i}`, url: `https://x/${i}.mp4` })
      await v.detectAndMark(p)
      if (p.mediaUrl) marked++
    }
    expect(marked).toBe(4)
  })
})
