import { describe, it, expect } from 'vitest'
import { filterNovel } from './dedup.js'
import type { CandidatePod } from './types.js'

const cand = (name: string): CandidatePod => ({ canonicalKey: name, podName: name, podDescription: '', dataset: {} })

describe('filterNovel', () => {
  it('drops candidates whose claim substantially overlaps an existing pod name', () => {
    const existing = ['Israel Lebanon ceasefire extended through June']
    const out = filterNovel(
      [cand('Israel Lebanon ceasefire extended'), cand('Taiwan invasion off the table 2027')],
      existing,
    )
    expect(out.map((c) => c.podName)).toEqual(['Taiwan invasion off the table 2027'])
  })
  it('keeps everything when there are no existing pods', () => {
    expect(filterNovel([cand('a claim about something')], [])).toHaveLength(1)
  })
  it('catches a reworded claim about the same event (overlap coefficient)', () => {
    const existing = ['Israel and Lebanon extend ceasefire through June 2026']
    const out = filterNovel([cand('Israel Lebanon ceasefire collapses after strike')], existing)
    expect(out).toEqual([])   // shares israel/lebanon/ceasefire → overlap >= 0.5 → dropped
  })
  it('dedups on the dataset claim (full text), not the short title podName', () => {
    // podName is now a short LLM headline whose few words make overlap noisy; the
    // dataset claim is the unit of dedup, matching what canonicalKey hashes.
    const c: CandidatePod = {
      canonicalKey: 'k', podName: 'US blacklists firms', podDescription: '',
      dataset: { claim: 'The US has added BYD and NIO to a Chinese military companies blacklist' },
    }
    // existing pod about the SAME event, named with the old full-claim style
    const existing = ['The US added BYD and NIO to a military companies blacklist prompting objection']
    expect(filterNovel([c], existing)).toEqual([]) // claim overlaps → dropped
  })
  it('dedups on dataset.take for sports candidates (same fallback chain as claim)', () => {
    const c: CandidatePod = {
      canonicalKey: 'k', podName: 'Short title', podDescription: '',
      dataset: { take: 'The Celtics defense collapses without Porzingis protecting the rim' },
    }
    const existing = ['Celtics defense collapses without Porzingis rim protection']
    expect(filterNovel([c], existing)).toEqual([]) // take overlaps → dropped
  })
  it('does NOT collapse two short same-topic claims that share only two significant words', () => {
    // "Celtics defense collapse" vs "Celtics offense collapse": shares celtics+collapse
    // (coeff 0.67) but only 2 words — a distinct claim that must survive (requires >=3).
    const c: CandidatePod = { canonicalKey: 'k', podName: 'x', podDescription: '', dataset: { take: 'Celtics offense collapse' } }
    const existing = ['Celtics defense collapse']
    expect(filterNovel([c], existing)).toHaveLength(1)
  })
})
