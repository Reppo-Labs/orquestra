import { describe, it, expect } from 'vitest'
import { filterNovel } from './dedup.js'
import type { CandidatePod } from '../types.js'

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
})
