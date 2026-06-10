import { describe, it, expect } from 'vitest'
import { synthesizeSignals, buildSignalPrompt, type SportsStrategy } from './signal.js'
import type { FeedItem } from './feeds.js'
import type { DatanetRubric } from '../../rubric/types.js'

const rubric = { name: 'Sports Signals', goal: 'price takes', publisherSpec: 'submit real signal sources', voterRubric: 'signal vs noise' } as DatanetRubric
const strategy: SportsStrategy = { focus: 'NBA and Premier League', angle: 'contrarian', brief: 'b', topN: 4, minSignal: 7 }
const items: FeedItem[] = [
  { title: 'Celtics defense piece', link: 'https://ex.com/a', description: 'd', pubDate: 'Tue, 10 Jun 2026 12:00:00 GMT', image: 'https://ex.com/a.jpg' },
  { title: 'Arsenal midfield piece', link: 'https://ex.com/b', description: 'd', pubDate: 'Tue, 10 Jun 2026 12:00:00 GMT', image: '' },
]
const gen = async () => ({ signals: [
  { sourceLink: 'https://ex.com/a', take: 'Celtics defense collapses without Porzingis protecting the rim', title: 'Celtics defense hinges on Porzingis', signal: 8, stance: 'bearish Celtics D', rationale: 'rotation numbers' },
  { sourceLink: 'https://ex.com/b', take: 'Arsenal double-pivot is a feature not a bug', title: 'Arsenal midfield gamble is fine', signal: 5, stance: 'pro Arsenal', rationale: 'weak: consensus' },
] })

describe('synthesizeSignals', () => {
  it('builds candidates, drops below minSignal, threads source link + image', async () => {
    const cands = await synthesizeSignals(items, rubric, '11', strategy, { generate: gen })
    expect(cands).toHaveLength(1) // signal 5 < 7 dropped
    const c = cands[0]
    expect(c.podName).toBe('Celtics defense hinges on Porzingis')
    expect(c.canonicalKey).toMatch(/^[0-9a-f]{16}$/)
    expect(c.sourceUrl).toBe('https://ex.com/a')
    expect(c.imageUrl).toBe('https://ex.com/a.jpg')
    expect(c.podDescription).toMatch(/^Take: /)
    expect(c.podDescription.length).toBeLessThanOrEqual(200)
    const ds = c.dataset as { kind: string; take: string; source: { url: string }; image: string }
    expect(ds.kind).toBe('sports-signal')
    expect(ds.source.url).toBe('https://ex.com/a')
    expect(ds.image).toBe('https://ex.com/a.jpg')
  })
  it('falls back to the clamped take when the model omits title; no imageUrl when source has none', async () => {
    const g = async () => ({ signals: [{ sourceLink: 'https://ex.com/b', take: 'Arsenal double-pivot is a deliberate tactical feature that wins the title', signal: 9, stance: 's', rationale: 'r' }] })
    const cands = await synthesizeSignals(items, rubric, '11', strategy, { generate: g })
    expect(cands[0].podName.length).toBeLessThanOrEqual(50)
    expect(cands[0].imageUrl).toBeUndefined()
    expect(cands[0].sourceUrl).toBe('https://ex.com/b')
  })
  it('canonicalKey is stable for the same take and distinct across takes', async () => {
    const g1 = async () => ({ signals: [{ sourceLink: 'https://ex.com/a', take: 'Same take text', signal: 9, stance: 's', rationale: 'r' }] })
    const g2 = async () => ({ signals: [{ sourceLink: 'https://ex.com/b', take: 'Same take text', signal: 9, stance: 's', rationale: 'r2' }] })
    const a = await synthesizeSignals(items, rubric, '11', strategy, { generate: g1 })
    const b = await synthesizeSignals(items, rubric, '11', strategy, { generate: g2 })
    expect(a[0].canonicalKey).toBe(b[0].canonicalKey) // same take, different source → same key
  })
  it('returns [] (no throw) when generate throws or yields nothing', async () => {
    expect(await synthesizeSignals(items, rubric, '11', strategy, { generate: async () => { throw new Error('llm down') } })).toEqual([])
    expect(await synthesizeSignals([], rubric, '11', strategy, { generate: gen })).toEqual([])
  })
  it('drops a signal whose sourceLink is not one of the input items (hallucinated source)', async () => {
    const g = async () => ({ signals: [{ sourceLink: 'https://evil.example/x', take: 'Invented take', signal: 9, stance: 's', rationale: 'r' }] })
    expect(await synthesizeSignals(items, rubric, '11', strategy, { generate: g })).toEqual([])
  })
})

describe('buildSignalPrompt', () => {
  it('carries the anti-noise rubric, untrusted guard, strategy, and item list', () => {
    const { system, prompt } = buildSignalPrompt(items, rubric, strategy)
    expect(system.toLowerCase()).toContain('untrusted')
    expect(system.toLowerCase()).toContain('never follow')
    expect(system.toLowerCase()).toContain('extract')          // extract, don't invent
    expect(prompt).toContain('NBA and Premier League')
    expect(prompt).toContain('no box-score recaps')
    expect(prompt).toContain('https://ex.com/a')
  })
})
