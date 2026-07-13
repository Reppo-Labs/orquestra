// src/voter/videoPipeline.test.ts
import { describe, it, expect, vi } from 'vitest'
import type { FilePart, LanguageModel } from 'ai'
import {
  createVideoPipeline, isVideoPod, VIDEO_DEFAULT_PROVIDER, VIDEO_DEFAULT_MODEL,
  type VideoPipelineDeps,
} from './videoPipeline.js'
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

// --- scoreVideoPod: model resolution + ingest + the cleanup-ordering invariant ---

const videoPod = (over: Partial<VoterPod> = {}) =>
  pod({ mediaUrl: 'https://x/c.mp4', mediaType: 'video/mp4', contentLength: 500, ...over })

const sentinelModel = {} as LanguageModel
const okPart: FilePart = { type: 'file', data: 'BASE64', mimeType: 'video/mp4' }

describe('scoreVideoPod model resolution', () => {
  it('explicit NON-google override → throws (video needs Gemini); ingest never runs', async () => {
    const ingest = vi.fn()
    const v = pipeline({ ingest: ingest as unknown as VideoPipelineDeps['ingest'] })
    await expect(
      v.scoreVideoPod(videoPod(), { provider: 'virtuals', model: 'claude-opus-4-8' }, async () => 1),
    ).rejects.toThrow(/video pod needs a Gemini model.*virtuals\/claude-opus-4-8/)
    expect(ingest).not.toHaveBeenCalled()
  })

  it('explicit google override without a key → throws with the provider named', async () => {
    const v = pipeline({ registry: reg(['virtuals', 'v']) })
    await expect(
      v.scoreVideoPod(videoPod(), { provider: 'google', model: 'gemini-3-pro' }, async () => 1),
    ).rejects.toThrow(/no API key for google/)
  })

  it('explicit google override + key → resolves THAT provider/slug/key', async () => {
    const resolveModel = vi.fn(() => sentinelModel)
    const generate = vi.fn(async () => 42)
    const v = pipeline({
      registry: reg(['google', 'gkey']),
      resolveModel,
      ingest: (async () => ({ part: okPart })) as VideoPipelineDeps['ingest'],
    })
    await expect(v.scoreVideoPod(videoPod(), { provider: 'google', model: 'gemini-3-pro' }, generate)).resolves.toBe(42)
    expect(resolveModel).toHaveBeenCalledWith('google', 'gkey', 'gemini-3-pro')
    expect(generate).toHaveBeenCalledWith(sentinelModel, okPart)
  })

  it('no override + google key → resolves the Gemini video default', async () => {
    const resolveModel = vi.fn(() => sentinelModel)
    const v = pipeline({
      registry: reg(['google', 'g']),
      resolveModel,
      ingest: (async () => ({ part: okPart })) as VideoPipelineDeps['ingest'],
    })
    await v.scoreVideoPod(videoPod(), undefined, async () => 1)
    expect(resolveModel).toHaveBeenCalledWith(VIDEO_DEFAULT_PROVIDER, 'g', VIDEO_DEFAULT_MODEL)
    expect(VIDEO_DEFAULT_PROVIDER).toBe('google')
    expect(VIDEO_DEFAULT_MODEL).toBe('gemini-3.1-pro-preview')
  })

  it('no override + NO google key → throws the LLM_KEY_GOOGLE hint; ingest never runs', async () => {
    const ingest = vi.fn()
    const v = pipeline({ registry: reg(['virtuals', 'v']), ingest: ingest as unknown as VideoPipelineDeps['ingest'] })
    await expect(v.scoreVideoPod(videoPod(), undefined, async () => 1)).rejects.toThrow(/video scoring needs a Google API key \(set LLM_KEY_GOOGLE\)/)
    expect(ingest).not.toHaveBeenCalled()
  })

  it('an unmarked pod (no mediaUrl) is rejected', async () => {
    await expect(pipeline().scoreVideoPod(pod(), undefined, async () => 1)).rejects.toThrow(/no mediaUrl/)
  })
})

describe('scoreVideoPod ingest', () => {
  it('threads url, mediaType (default video/mp4), contentLength (default null) and the google key into ingest', async () => {
    const ingest = vi.fn(async () => ({ part: okPart }))
    const v = pipeline({ registry: reg(['google', 'gk']), ingest: ingest as unknown as VideoPipelineDeps['ingest'] })
    await v.scoreVideoPod(videoPod({ mediaType: undefined, contentLength: undefined }), undefined, async () => 1)
    expect(ingest).toHaveBeenCalledWith({ url: 'https://x/c.mp4', mediaType: 'video/mp4', contentLength: null, googleKey: 'gk' })
    await v.scoreVideoPod(videoPod(), undefined, async () => 1)
    expect(ingest).toHaveBeenLastCalledWith({ url: 'https://x/c.mp4', mediaType: 'video/mp4', contentLength: 500, googleKey: 'gk' })
  })

  it('an ingest skip THROWS its reason and generate never runs', async () => {
    const generate = vi.fn(async () => 1)
    const v = pipeline({ ingest: (async () => ({ skip: 'video 999 bytes exceeds VIDEO_MAX_BYTES' })) as VideoPipelineDeps['ingest'] })
    await expect(v.scoreVideoPod(videoPod(), undefined, generate)).rejects.toThrow(/exceeds VIDEO_MAX_BYTES/)
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('scoreVideoPod cleanup ordering (the module invariant)', () => {
  it('cleanup runs only AFTER generate has settled (deleting before would 404 the fileData read)', async () => {
    const order: string[] = []
    const cleanup = vi.fn(async () => { order.push('cleanup') })
    const v = pipeline({ ingest: (async () => ({ part: okPart, cleanup })) as VideoPipelineDeps['ingest'] })
    const result = await v.scoreVideoPod(videoPod(), undefined, async () => {
      // The remote file must still exist while the model reads the fileData URI.
      expect(cleanup).not.toHaveBeenCalled()
      order.push('generate')
      return 'scored'
    })
    expect(result).toBe('scored')
    expect(order).toEqual(['generate', 'cleanup'])
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('cleanup ALSO runs when generate throws (no orphaned remote file), and the error propagates', async () => {
    const cleanup = vi.fn(async () => {})
    const v = pipeline({ ingest: (async () => ({ part: okPart, cleanup })) as VideoPipelineDeps['ingest'] })
    await expect(
      v.scoreVideoPod(videoPod(), undefined, async () => { throw new Error('model exploded') }),
    ).rejects.toThrow('model exploded')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('the inline path (no cleanup returned) scores without error', async () => {
    const v = pipeline({ ingest: (async () => ({ part: okPart })) as VideoPipelineDeps['ingest'] })
    await expect(v.scoreVideoPod(videoPod(), undefined, async () => 7)).resolves.toBe(7)
  })
})
