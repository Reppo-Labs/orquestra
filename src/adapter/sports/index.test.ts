import { describe, it, expect, vi } from 'vitest'
import { createSportsAdapter } from './index.js'
import type { FeedItem } from './feeds.js'
import type { DatanetRubric } from '../../rubric/types.js'

const rubric = { name: 'Sports Signals', goal: 'g', publisherSpec: 'p', voterRubric: 'v', canMint: true } as DatanetRubric
const strategy = { focus: 'NBA', angle: 'contrarian', brief: 'b', topN: 4, minSignal: 7 }
const item = (link: string): FeedItem => ({ title: 't', link, description: 'd', pubDate: new Date().toUTCString(), image: '' })
const gen = async () => ({ signals: [{ sourceLink: 'https://ex.com/a', take: 'A strong contrarian take on the Celtics rotation', signal: 8, stance: 's', rationale: 'r' }] })

describe('createSportsAdapter', () => {
  it('has id "sports"; discover fetches feeds, synthesizes, returns candidates', async () => {
    const fetchFeed = vi.fn(async () => [item('https://ex.com/a')])
    const a = createSportsAdapter({ fetchFeed, generate: gen, feeds: ['https://feed/1'] })
    expect(a.id).toBe('sports')
    const cands = await a.discover({ datanetId: '11', rubric, topN: 4, strategy })
    expect(cands).toHaveLength(1)
    expect(cands[0].sourceUrl).toBe('https://ex.com/a')
  })
  it('tolerates one failing feed (others proceed); ALL feeds failing → []', async () => {
    const fetchFeed = vi.fn(async (u: string) => { if (u === 'https://feed/bad') throw new Error('404'); return [item('https://ex.com/a')] })
    const a = createSportsAdapter({ fetchFeed, generate: gen, feeds: ['https://feed/bad', 'https://feed/good'] })
    expect(await a.discover({ datanetId: '11', rubric, topN: 4, strategy })).toHaveLength(1)
    const allBad = createSportsAdapter({ fetchFeed: async () => { throw new Error('404') }, generate: gen, feeds: ['https://feed/bad'] })
    expect(await allBad.discover({ datanetId: '11', rubric, topN: 4, strategy })).toEqual([])
  })
  it('throttles repeat discovery within minFetchIntervalMs, armed only on success', async () => {
    let clock = 1_000_000
    const fetchFeed = vi.fn(async () => [item('https://ex.com/a')])
    const a = createSportsAdapter({ fetchFeed, generate: gen, feeds: ['https://feed/1'], minFetchIntervalMs: 30 * 60_000, now: () => clock })
    await a.discover({ datanetId: '11', rubric, topN: 4, strategy })
    clock += 60_000
    expect(await a.discover({ datanetId: '11', rubric, topN: 4, strategy })).toEqual([]) // throttled
    expect(fetchFeed).toHaveBeenCalledTimes(1)
    clock += 30 * 60_000
    await a.discover({ datanetId: '11', rubric, topN: 4, strategy })
    expect(fetchFeed).toHaveBeenCalledTimes(2)
  })
  it('a failed discovery (all feeds down) does NOT arm the throttle', async () => {
    let clock = 1_000_000, calls = 0
    const fetchFeed = vi.fn(async () => { calls++; if (calls === 1) throw new Error('429'); return [item('https://ex.com/a')] })
    const a = createSportsAdapter({ fetchFeed, generate: gen, feeds: ['https://feed/1'], minFetchIntervalMs: 30 * 60_000, now: () => clock })
    expect(await a.discover({ datanetId: '11', rubric, topN: 4, strategy })).toEqual([])
    clock += 60_000
    expect(await a.discover({ datanetId: '11', rubric, topN: 4, strategy })).toHaveLength(1) // retried, not throttled
  })
  it('resolves the model via getModel at each discover — live, not frozen at construction', async () => {
    let clock = 1_000_000
    const getModel = vi.fn(() => undefined)
    const a = createSportsAdapter({
      fetchFeed: async () => [item('https://ex.com/a')], generate: gen, feeds: ['https://feed/1'],
      getModel, minFetchIntervalMs: 30 * 60_000, now: () => clock,
    })
    expect(getModel).not.toHaveBeenCalled() // construction must not freeze a model
    await a.discover({ datanetId: '11', rubric, topN: 4, strategy })
    expect(getModel).toHaveBeenCalledTimes(1)
    clock += 31 * 60_000 // past the throttle
    await a.discover({ datanetId: '11', rubric, topN: 4, strategy })
    expect(getModel).toHaveBeenCalledTimes(2) // re-resolved per discover (dashboard model change applies)
  })
  it('parses ctx.strategy itself — wrong-typed operator params fall back to defaults, never crash', async () => {
    const fetchFeed = vi.fn(async () => [item('https://ex.com/a')])
    let seenPrompt = ''
    const capture = async (args: { system: string; prompt: string }) => { seenPrompt = args.prompt; return { signals: [] } }
    const a = createSportsAdapter({ fetchFeed, generate: capture, feeds: ['https://feed/1'] })
    // adapterParams come from operator-edited config — a malformed save must degrade, not throw.
    // feeds as a bare string used to crash discover (`feeds.join` on a string).
    const malformed = { feeds: 'https://not-an-array', maxAgeHours: 'soon', topN: [], focus: 7 } as unknown as Record<string, unknown>
    await expect(a.discover({ datanetId: '11', rubric, topN: 4, strategy: malformed })).resolves.toEqual([])
    expect(fetchFeed).toHaveBeenCalledWith('https://feed/1') // fell back to deps.feeds
    expect(seenPrompt).toContain('up to 4')                  // topN falls back to the cycle's topN
    expect(seenPrompt).toContain('major-league sports')      // default focus, not 7
  })
  it('applies the novelty backstop against existingPodNames (take text)', async () => {
    const fetchFeed = async () => [item('https://ex.com/a')]
    const a = createSportsAdapter({ fetchFeed, generate: gen, feeds: ['https://feed/1'] })
    const cands = await a.discover({
      datanetId: '11', rubric, topN: 4, strategy,
      existingPodNames: ['A strong contrarian take on the Celtics rotation today'],
    })
    expect(cands).toEqual([])
  })
})
