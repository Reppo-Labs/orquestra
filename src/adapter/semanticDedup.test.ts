// src/adapter/semanticDedup.test.ts
import { describe, it, expect, vi } from 'vitest'
import { filterNovelSemantic } from './semanticDedup.js'
import type { CandidatePod } from './types.js'

const pod = (key: string, name: string, claim: string): CandidatePod => ({
  canonicalKey: key,
  podName: name,
  podDescription: `desc ${name}`,
  dataset: { claim },
})

const candidates: CandidatePod[] = [
  pod('k0', 'Oil tumbles on Iran deal optimism', 'Crude prices fall as Iran nuclear deal nears.'),
  pod('k1', 'Lakers clinch playoff berth', 'The Lakers secured a playoff spot last night.'),
]
const existing = ['Brent slides to March lows on Iran deal', 'Fed holds rates steady']

describe('filterNovelSemantic', () => {
  it('drops a candidate the judge marks as a duplicate', async () => {
    const generate = vi.fn(async () => ({ duplicateIndices: [0] }))
    const out = await filterNovelSemantic(candidates, existing, { generate })
    expect(generate).toHaveBeenCalledOnce()
    expect(out.map((c) => c.canonicalKey)).toEqual(['k1'])
  })

  it('keeps all when the judge returns no duplicates', async () => {
    const generate = vi.fn(async () => ({ duplicateIndices: [] }))
    const out = await filterNovelSemantic(candidates, existing, { generate })
    expect(out).toEqual(candidates)
  })

  it('returns candidates unchanged when the LLM throws (best-effort)', async () => {
    const generate = vi.fn(async () => { throw new Error('rate limited') })
    const out = await filterNovelSemantic(candidates, existing, { generate })
    expect(out).toEqual(candidates)
  })

  it('does not call the generator when there are no existing pods', async () => {
    const generate = vi.fn(async () => ({ duplicateIndices: [0] }))
    const out = await filterNovelSemantic(candidates, [], { generate })
    expect(generate).not.toHaveBeenCalled()
    expect(out).toEqual(candidates)
  })

  it('is a no-op when neither model nor generate is provided', async () => {
    const out = await filterNovelSemantic(candidates, existing, {})
    expect(out).toEqual(candidates)
  })

  it('ignores out-of-range duplicate indices', async () => {
    const generate = vi.fn(async () => ({ duplicateIndices: [99] }))
    const out = await filterNovelSemantic(candidates, existing, { generate })
    expect(out).toEqual(candidates)
  })
})
