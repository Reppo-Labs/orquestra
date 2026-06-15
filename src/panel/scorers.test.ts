// src/panel/scorers.test.ts
import { describe, it, expect, vi } from 'vitest'
import type { DatanetRubric } from '../rubric/types.js'
import type { PodScorer } from '../voter/types.js'
import type { CandidateScorer, CandidatePod } from '../adapter/types.js'
import { createPanelPodScorer, createPanelCandidateScorer, type PanelScorerOpts } from './scorers.js'
import type { PanelGenerate } from './deliberate.js'

const rubric = { name: 'D', goal: 'g', voterRubric: 'v', canVote: true, canMint: true } as DatanetRubric
const pod = { podId: '1', validityEpoch: '1', name: 'p', description: 'd' }
const model = null as never

// A panel backend that always succeeds; judge rules 6.
const okGen: PanelGenerate = (async ({ system }) =>
  system.includes('You are the JUDGE') ? { score: 6, reason: 'panel reason' } : { score: 6, argument: 'arg' }) as PanelGenerate

const basePod = (score: number): PodScorer => ({ scorePod: vi.fn(async () => ({ score, reason: 'single' })) })
// Helper takes flat enabled/votePanel/generate and produces the live-getter opts shape.
const opts = (o: { enabled?: boolean; votePanel?: boolean; generate?: PanelGenerate } = {}): PanelScorerOpts => ({
  model,
  getDeliberation: () => ({ enabled: o.enabled ?? true, votePanel: o.votePanel ?? true }),
  generate: o.generate ?? okGen,
})

describe('createPanelPodScorer (votes, all-or-none)', () => {
  it('disabled → single scorer, no panel', async () => {
    const r = await createPanelPodScorer(basePod(6), opts({ enabled: false })).scorePod(pod, rubric, { like: 7, dislike: 3 })
    expect(r).toEqual({ score: 6, reason: 'single' })
    expect(r.panel).toBeUndefined()
  })

  it('votePanel=false → single scorer, no panel (mints-only mode)', async () => {
    const r = await createPanelPodScorer(basePod(6), opts({ votePanel: false })).scorePod(pod, rubric, { like: 7, dislike: 3 })
    expect(r.score).toBe(6)
    expect(r.panel).toBeUndefined()
  })

  it('enabled + votePanel → EVERY vote panels; judge score wins, transcript attached', async () => {
    const r = await createPanelPodScorer(basePod(10), opts()).scorePod(pod, rubric, { like: 7, dislike: 3 })
    expect(r.score).toBe(6) // judge overrode the single scorer's 10 — panel ran regardless of score
    expect(r.reason).toBe('panel reason')
    expect(r.panel?.judge.score).toBe(6)
  })

  it('panel failure → falls back to the single scorer (never more fragile)', async () => {
    const failGen: PanelGenerate = (async () => { throw new Error('all down') }) as PanelGenerate
    const r = await createPanelPodScorer(basePod(8), opts({ generate: failGen })).scorePod(pod, rubric, { like: 7, dislike: 3 })
    expect(r.score).toBe(8) // single scorer stands
    expect(r.panel).toBeUndefined()
  })

  it('injects the per-datanet lessons block into the JUDGE prompt only (personas stay lesson-free)', async () => {
    let judgePrompt = ''
    let personaPrompt = ''
    const capGen: PanelGenerate = (async ({ system, prompt }) => {
      if (system.includes('You are the JUDGE')) { judgePrompt = prompt; return { score: 6, reason: 'r' } }
      personaPrompt = prompt
      return { score: 6, argument: 'a' }
    }) as PanelGenerate
    const rub = { ...rubric, datanetId: '9' } as DatanetRubric
    const o: PanelScorerOpts = {
      model,
      getDeliberation: () => ({ enabled: true, votePanel: true }),
      generate: capGen,
      getLessons: (id) => (id === '9' ? '\n## Learned lessons (trusted)\n1. tighten the unsourced read (misaligned 7/9)\n' : ''),
    }
    await createPanelPodScorer(basePod(8), o).scorePod(pod, rub, { like: 7, dislike: 3 })
    expect(judgePrompt).toContain('Learned lessons')
    expect(judgePrompt).toContain('tighten the unsourced read')
    expect(personaPrompt).not.toContain('Learned lessons')
  })
})

describe('createPanelCandidateScorer (mints, always panel while enabled)', () => {
  const candidate = { canonicalKey: 'k', podName: 'n', podDescription: 'd', dataset: { a: 1 } } as CandidatePod

  it('disabled → pass-through to the base candidate scorer', async () => {
    const baseCand: CandidateScorer = { scoreCandidate: vi.fn(async () => ({ score: 9, reason: 'base' })) }
    const r = await createPanelCandidateScorer(baseCand, opts({ enabled: false })).scoreCandidate(candidate, rubric)
    expect(r).toEqual({ score: 9, reason: 'base' })
  })

  it('enabled → always panels (no screen), regardless of votePanel', async () => {
    const base = { scoreCandidate: vi.fn(async () => ({ score: 9, reason: 'base' })) }
    const r = await createPanelCandidateScorer(base, opts({ votePanel: false })).scoreCandidate(candidate, rubric)
    expect(base.scoreCandidate).not.toHaveBeenCalled() // mints skip the single scorer
    expect(r.score).toBe(6)
    expect(r.panel?.judge.score).toBe(6)
  })

  it('panel failure → throws (selectMints skips the candidate)', async () => {
    const baseCand: CandidateScorer = { scoreCandidate: vi.fn(async () => ({ score: 9, reason: 'base' })) }
    const failGen: PanelGenerate = (async () => { throw new Error('panel down') }) as PanelGenerate
    const s = createPanelCandidateScorer(baseCand, opts({ generate: failGen }))
    await expect(s.scoreCandidate(candidate, rubric)).rejects.toThrow()
  })
})
