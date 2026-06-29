// src/adapter/semanticDedup.test.ts
import { describe, it, expect, vi } from 'vitest'
import { filterNovelSemantic, buildDedupPrompt } from './semanticDedup.js'
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

describe('buildDedupPrompt', () => {
  it('wraps data in XML tags and places candidates by index attribute', () => {
    const { system, prompt } = buildDedupPrompt(candidates, existing)
    expect(system).toContain('<existing_pod>')
    expect(system).toContain('UNTRUSTED')
    expect(prompt).toContain('<existing_pods>')
    expect(prompt).toContain('<existing_pod>Brent slides to March lows on Iran deal</existing_pod>')
    expect(prompt).toContain('<new_candidates>')
    expect(prompt).toContain('<candidate index="0">')
    expect(prompt).toContain('<candidate index="1">')
  })

  it('strips control characters from pod names', () => {
    const malicious = [pod('km', 'Inject\nFake section\r\n', 'payload')]
    const { prompt } = buildDedupPrompt(malicious, ['clean pod'])
    // newline in pod name must not survive into the prompt (would break XML structure)
    expect(prompt).toContain('<name>Inject Fake section</name>')
    expect(prompt).not.toContain('Inject\n')
  })

  it('truncates long claim text to 300 chars and pod name to 150', () => {
    const longClaim = 'x'.repeat(400)
    const longName = 'n'.repeat(200)
    const p = [pod('kl', longName, longClaim)]
    const { prompt } = buildDedupPrompt(p, ['ref'])
    expect(prompt).toContain('n'.repeat(150))
    expect(prompt).not.toContain('n'.repeat(151))
    expect(prompt).toContain('x'.repeat(300))
    expect(prompt).not.toContain('x'.repeat(301))
  })
})
