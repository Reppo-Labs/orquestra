import { describe, it, expect, vi } from 'vitest'
import { createGdeltAdapter } from './index.js'
import type { GeoArticle } from './gdelt.js'
import type { DatanetRubric } from '../../rubric/types.js'

const rubric = { name: 'Geo', goal: 'g', publisherSpec: 'p', voterRubric: 'v', canMint: true } as DatanetRubric
const articles: GeoArticle[] = [{ url: 'https://ex.com/a', title: 'Ceasefire extended', domain: 'ex.com', seendate: 't' }]
const strategy = { focus: 'ME', angle: 'contrarian', brief: 'b', topN: 5, minImportance: 7 }
const gen = async () => ({ claims: [
  { claim: 'Ceasefire holds through June', verdict: 'credible', confidence: 7, importance: 8, rationale: 'r', sources: ['https://ex.com/a'] },
] })

describe('createGdeltAdapter', () => {
  it('has id "gdelt"', () => {
    expect(createGdeltAdapter({ fetchEvents: async () => articles, generate: gen }).id).toBe('gdelt')
  })
  it('discover() fetches, synthesizes personalized claims, returns candidates', async () => {
    const fetchEvents = vi.fn(async () => articles)
    const a = createGdeltAdapter({ fetchEvents, generate: gen })
    const cands = await a.discover({ datanetId: '2', rubric, topN: 5, strategy })
    expect(cands).toHaveLength(1)
    expect(cands[0].podName).toBe('Ceasefire holds through June')
    expect(fetchEvents).toHaveBeenCalledOnce()
  })
  it('applies the novelty backstop against existingPodNames', async () => {
    const a = createGdeltAdapter({ fetchEvents: async () => articles, generate: gen })
    const cands = await a.discover({ datanetId: '2', rubric, topN: 5, strategy, existingPodNames: ['Ceasefire holds through June'] })
    expect(cands).toEqual([])
  })
  it('empty GDELT → [] (no synthesis)', async () => {
    const a = createGdeltAdapter({ fetchEvents: async () => [], generate: gen })
    expect(await a.discover({ datanetId: '2', rubric, topN: 5, strategy })).toEqual([])
  })
  it('GDELT fetch failure (e.g. 429 rate limit) → [] this cycle, no throw into the cycle', async () => {
    const a = createGdeltAdapter({ fetchEvents: async () => { throw new Error('curl: (22) The requested URL returned error: 429') }, generate: gen })
    await expect(a.discover({ datanetId: '2', rubric, topN: 5, strategy })).resolves.toEqual([])
  })
  it('sanitizes the free-text focus into a valid GDELT query (no commas/slashes)', async () => {
    let seenQuery = ''
    const fetchEvents = vi.fn(async (q: { query: string }) => { seenQuery = q.query; return articles })
    const a = createGdeltAdapter({ fetchEvents, generate: gen })
    await a.discover({ datanetId: '2', rubric, topN: 5, strategy: { ...strategy, focus: 'Middle East conflict, Taiwan/China tensions' } })
    expect(seenQuery).toBe('("Middle East conflict" OR "Taiwan China tensions")')
    expect(seenQuery).not.toMatch(/[,/]/)
  })
  it('honors the operator strategy topN over the cycle topN', async () => {
    let seenPrompt = ''
    const capture = async (args: { system: string; prompt: string }) => { seenPrompt = args.prompt; return { claims: [] } }
    const a = createGdeltAdapter({ fetchEvents: async () => articles, generate: capture })
    await a.discover({ datanetId: '2', rubric, topN: 12, strategy: { ...strategy, topN: 3 } })
    expect(seenPrompt).toContain('up to 3')   // strategy topN 3 wins over ctx.topN 12
  })
})
