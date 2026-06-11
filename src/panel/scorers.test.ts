// src/panel/scorers.test.ts
import { describe, it, expect, vi } from 'vitest'
import type { DatanetRubric } from '../rubric/types.js'
import type { PodScorer } from '../voter/types.js'
import type { CandidateScorer, CandidatePod } from '../adapter/types.js'
import { createPanelPodScorer, createPanelCandidateScorer, withinBand, type PanelScorerOpts } from './scorers.js'
import type { PanelGenerate } from './deliberate.js'

const rubric = { name: 'D', goal: 'g', voterRubric: 'v', canVote: true, canMint: true } as DatanetRubric
const pod = { podId: '1', validityEpoch: '1', name: 'p', description: 'd' }
const model = null as never

// A panel backend that always succeeds; judge rules 6.
const okGen: PanelGenerate = (async ({ system }) =>
  system.includes('You are the JUDGE') ? { score: 6, reason: 'panel reason' } : { score: 6, argument: 'arg' }) as PanelGenerate

const basePod = (score: number): PodScorer => ({ scorePod: vi.fn(async () => ({ score, reason: 'screen' })) })
const opts = (o: Partial<PanelScorerOpts> = {}): PanelScorerOpts => ({ model, enabled: true, voteBand: 1, generate: okGen, ...o })

describe('withinBand', () => {
  const t = { like: 7, dislike: 3 }
  it('is true within ±band of either threshold', () => {
    expect(withinBand(6, t, 1)).toBe(true) // like-1
    expect(withinBand(8, t, 1)).toBe(true) // like+1
    expect(withinBand(4, t, 1)).toBe(true) // dislike+1
    expect(withinBand(2, t, 1)).toBe(true) // dislike-1
  })
  it('is false in the decisive zones', () => {
    expect(withinBand(10, t, 1)).toBe(false)
    expect(withinBand(5, t, 1)).toBe(false) // mid, >1 from both
  })
})

describe('createPanelPodScorer (votes, tiered)', () => {
  it('disabled → pass-through to the base scorer, no panel', async () => {
    const base = basePod(6)
    const s = createPanelPodScorer(base, opts({ enabled: false }))
    const r = await s.scorePod(pod, rubric, { like: 7, dislike: 3 })
    expect(r).toEqual({ score: 6, reason: 'screen' })
    expect(r.panel).toBeUndefined()
  })

  it('decisive screen score → keeps screen, no panel', async () => {
    const s = createPanelPodScorer(basePod(10), opts())
    const r = await s.scorePod(pod, rubric, { like: 7, dislike: 3 })
    expect(r.score).toBe(10)
    expect(r.panel).toBeUndefined()
  })

  it('ambiguous screen score → convenes panel, judge score wins, transcript attached', async () => {
    const s = createPanelPodScorer(basePod(8), opts()) // 8 = like+1 → ambiguous
    const r = await s.scorePod(pod, rubric, { like: 7, dislike: 3 })
    expect(r.score).toBe(6) // judge overrode screen
    expect(r.reason).toBe('panel reason')
    expect(r.panel?.screenScore).toBe(8)
    expect(r.panel?.judge.score).toBe(6)
  })

  it('panel failure → falls back to the screen result (never more fragile)', async () => {
    const failGen: PanelGenerate = (async () => { throw new Error('all down') }) as PanelGenerate
    const s = createPanelPodScorer(basePod(8), opts({ generate: failGen }))
    const r = await s.scorePod(pod, rubric, { like: 7, dislike: 3 })
    expect(r.score).toBe(8) // screen stands
    expect(r.panel).toBeUndefined()
  })

  it('voteBand 0 → never panels votes even on an exact threshold hit (mints only)', async () => {
    const s = createPanelPodScorer(basePod(7), opts({ voteBand: 0 })) // 7 == like
    const r = await s.scorePod(pod, rubric, { like: 7, dislike: 3 })
    expect(r.score).toBe(7)
    expect(r.panel).toBeUndefined()
  })

  it('no thresholds → screen stands (defensive)', async () => {
    const s = createPanelPodScorer(basePod(8), opts())
    const r = await s.scorePod(pod, rubric)
    expect(r.score).toBe(8)
    expect(r.panel).toBeUndefined()
  })
})

describe('createPanelCandidateScorer (mints, always panel)', () => {
  const candidate = { canonicalKey: 'k', podName: 'n', podDescription: 'd', dataset: { a: 1 } } as CandidatePod

  it('disabled → pass-through to the base candidate scorer', async () => {
    const baseCand: CandidateScorer = { scoreCandidate: vi.fn(async () => ({ score: 9, reason: 'base' })) }
    const s = createPanelCandidateScorer(baseCand, opts({ enabled: false }))
    const r = await s.scoreCandidate(candidate, rubric)
    expect(r).toEqual({ score: 9, reason: 'base' })
  })

  it('enabled → always panels (no screen), attaches transcript with no screenScore', async () => {
    const base = { scoreCandidate: vi.fn(async () => ({ score: 9, reason: 'base' })) }
    const s = createPanelCandidateScorer(base, opts())
    const r = await s.scoreCandidate(candidate, rubric)
    expect(base.scoreCandidate).not.toHaveBeenCalled() // mints skip the screen
    expect(r.score).toBe(6)
    expect(r.panel?.screenScore).toBeUndefined()
    expect(r.panel?.judge.score).toBe(6)
  })

  it('panel failure → throws (selectMints skips the candidate)', async () => {
    const baseCand: CandidateScorer = { scoreCandidate: vi.fn(async () => ({ score: 9, reason: 'base' })) }
    const failGen: PanelGenerate = (async () => { throw new Error('panel down') }) as PanelGenerate
    const s = createPanelCandidateScorer(baseCand, opts({ generate: failGen }))
    await expect(s.scoreCandidate(candidate, rubric)).rejects.toThrow()
  })
})
