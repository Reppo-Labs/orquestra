import { describe, it, expect } from 'vitest'
import { buildSynthesisPrompt, type GdeltStrategy } from './claim.js'
import { synthesizeClaims } from './claim.js'
import type { GeoArticle } from './gdelt.js'
import type { DatanetRubric } from '../../rubric/types.js'

const rubric = { name: 'Geopolitics', goal: 'g', publisherSpec: 'submit sources', voterRubric: 'price truth' } as DatanetRubric
const strategy: GdeltStrategy = { focus: 'Middle East energy', angle: 'contrarian on ceasefires', brief: 'favor sanctions impact', topN: 5, minImportance: 7 }
const articles: GeoArticle[] = [{ url: 'https://ex.com/a', title: 'Ceasefire extended', domain: 'ex.com', seendate: '20260608T120000Z' }]

const fakeGenerate = async () => ({
  claims: [
    { claim: 'Ceasefire holds through June', verdict: 'credible' as const, confidence: 7, importance: 8, timeframe: 'through 2026-06', rationale: 'multiple sources', sources: ['https://ex.com/a'] },
    { claim: 'Minor border skirmish irrelevant', verdict: 'likely' as const, confidence: 5, importance: 3, rationale: 'low signal', sources: ['https://ex.com/b'] },
  ],
})

describe('synthesizeClaims', () => {
  const r = { name: 'Geo', goal: 'g', publisherSpec: 'p', voterRubric: 'v' } as DatanetRubric
  const s: GdeltStrategy = { focus: 'ME', angle: 'contrarian', brief: 'b', topN: 5, minImportance: 7 }
  const arts: GeoArticle[] = [{ url: 'https://ex.com/a', title: 'x', domain: 'ex.com', seendate: 't' }]

  it('builds candidates and drops those below minImportance', async () => {
    const cands = await synthesizeClaims(arts, r, '9', s, { generate: fakeGenerate })
    expect(cands).toHaveLength(1)
    expect(cands[0].podName).toBe('Ceasefire holds through June')
    expect(cands[0].canonicalKey).toMatch(/^[0-9a-f]{16}$/)
    const ds = cands[0].dataset as { verdict: string; sources: unknown[] }
    expect(ds.verdict).toBe('credible')
    expect(ds.sources).toHaveLength(1)
  })
  it('returns [] when the model yields no usable claims', async () => {
    expect(await synthesizeClaims(arts, r, '9', s, { generate: async () => ({ claims: [] }) })).toEqual([])
  })
  it('returns [] (no throw) when generate throws', async () => {
    expect(await synthesizeClaims(arts, r, '9', s, { generate: async () => { throw new Error('llm down') } })).toEqual([])
  })
  it('canonicalKey is stable for the same claim and distinct for different claims', async () => {
    const g1 = async () => ({ claims: [{ claim: 'Ceasefire holds through June', verdict: 'credible' as const, confidence: 7, importance: 8, rationale: 'r', sources: ['https://ex.com/a'] }] })
    const g2 = async () => ({ claims: [{ claim: 'Ceasefire holds through June', verdict: 'credible' as const, confidence: 7, importance: 8, rationale: 'r2', sources: ['https://OTHER.com/z'] }] })
    const a = await synthesizeClaims(arts, r, '9', s, { generate: g1 })
    const b = await synthesizeClaims(arts, r, '9', s, { generate: g2 })
    expect(a[0].canonicalKey).toBe(b[0].canonicalKey)   // same claim, different source URL → same key
  })
  it('uses the LLM short title as podName, clamped to 50 chars', async () => {
    const g = async () => ({ claims: [{
      claim: 'A long falsifiable claim that would blow past the CLI pod-name limit if used directly as the name',
      title: 'US blacklists BYD and NIO over military links',
      verdict: 'credible' as const, confidence: 8, importance: 9,
      rationale: 'r', sources: ['https://ex.com/a'],
    }] })
    const cands = await synthesizeClaims(arts, r, '2', s, { generate: g })
    expect(cands[0].podName).toBe('US blacklists BYD and NIO over military links')
  })
  it('clamps the assembled podDescription to the CLI 200-char limit (long rationale + url)', async () => {
    const g = async () => ({ claims: [{
      claim: 'Oil stays below $100 through Q3',
      verdict: 'likely' as const, confidence: 7, importance: 9,
      rationale: 'Multiple energy-market sources align on sub-$100 oil, falling pump prices, and record flows; the durability warning is analyst opinion, inherently probabilistic, and several desks expect continued softness. '.repeat(2),
      sources: ['https://example.com/featured/portland-local-news/content/2026-06-09-lower-crude-oil-prices-bring-gas-prices-down/'],
    }] })
    const cands = await synthesizeClaims(arts, r, '2', s, { generate: g })
    expect(cands[0].podDescription.length).toBeLessThanOrEqual(200)
    expect(cands[0].podDescription).toMatch(/^Verdict: likely/)
  })
  it('falls back to the clamped claim when the model omits the title', async () => {
    const longClaim = 'The US has added major Chinese firms including BYD and NIO to a military blacklist prompting formal objection from Beijing'
    const g = async () => ({ claims: [{
      claim: longClaim, verdict: 'credible' as const, confidence: 8, importance: 9,
      rationale: 'r', sources: ['https://ex.com/a'],
    }] })
    const cands = await synthesizeClaims(arts, r, '2', s, { generate: g })
    expect(cands[0].podName.length).toBeLessThanOrEqual(50)
    expect(longClaim.startsWith(cands[0].podName)).toBe(true)
  })
  it('two distinct claims citing the SAME source get distinct keys (no collision)', async () => {
    const g = async () => ({ claims: [
      { claim: 'Ceasefire holds through June', verdict: 'credible' as const, confidence: 7, importance: 8, rationale: 'r', sources: ['https://ex.com/a'] },
      { claim: 'Oil prices stabilize after the deal', verdict: 'likely' as const, confidence: 7, importance: 8, rationale: 'r', sources: ['https://ex.com/a'] },
    ] })
    const cands = await synthesizeClaims(arts, r, '9', s, { generate: g })
    expect(cands).toHaveLength(2)
    expect(cands[0].canonicalKey).not.toBe(cands[1].canonicalKey)
  })
})

describe('buildSynthesisPrompt', () => {
  it('includes the operator focus, angle, brief, the datanet rubric, and the articles', () => {
    const { prompt } = buildSynthesisPrompt(articles, rubric, strategy)
    expect(prompt).toContain('Middle East energy')
    expect(prompt).toContain('contrarian on ceasefires')
    expect(prompt).toContain('favor sanctions impact')
    expect(prompt).toContain('submit sources')
    expect(prompt).toContain('Ceasefire extended')
  })
  it('carries the untrusted-content injection guard in the system prompt', () => {
    const { system } = buildSynthesisPrompt(articles, rubric, strategy)
    expect(system.toLowerCase()).toContain('untrusted')
    expect(system.toLowerCase()).toContain('never follow')
  })
})
