// src/voter/select.test.ts
import { describe, it, expect } from 'vitest'
import { selectVotes } from './select.js'
import type { VoterPod, VoteFilter, PodScorer } from './types.js'
import type { DatanetRubric } from '../rubric/types.js'

const rubric: DatanetRubric = {
  datanetId: '9', name: 'TradingGym AI', goal: 'g', publisherSpec: 'p', voterRubric: 'score 1-10',
  canVote: true, canMint: true, status: 'ACTIVE', subnetUuid: 'cm-test-9',
  economics: { accessFeeReppo: 50, emissionsPerEpochReppo: 500, upVoteVolume: 1, downVoteVolume: 1, nativeTokenSymbol: 'REPPO' },
}
const pod = (podId: string, validityEpoch = '100'): VoterPod => ({ podId, validityEpoch, name: `pod ${podId}`, description: 'd' })
const filter = (over: Partial<VoteFilter> = {}): VoteFilter => ({ currentEpoch: '100', ownPodIds: [], votedPodIds: [], ...over })

/** Fake scorer: score by podId from a lookup, default 5. */
const scorerOf = (scores: Record<string, number>): PodScorer => ({
  scorePod: async (p) => ({ score: scores[p.podId] ?? 5, reason: `r:${p.podId}` }),
})

describe('selectVotes (conservative: like>=8, dislike<=4)', () => {
  it('maps high→up, low→down, mid→skip; conviction = score; reason passes through', async () => {
    const pods = [pod('hi'), pod('lo'), pod('mid')]
    const votes = await selectVotes('9', pods, rubric, 'conservative', filter(), scorerOf({ hi: 9, lo: 3, mid: 6 }))
    expect(votes).toHaveLength(2)
    const hi = votes.find((v) => v.podId === 'hi')!
    expect(hi.direction).toBe('up'); expect(hi.conviction).toBe(9); expect(hi.reason).toBe('r:hi')
    expect(votes.find((v) => v.podId === 'lo')!.direction).toBe('down')
    expect(votes.find((v) => v.podId === 'mid')).toBeUndefined() // 6 is between 4 and 8 → skip
  })

  it('skips out-of-epoch, own, and already-voted pods (never scores/votes them)', async () => {
    let scored: string[] = []
    const tracking: PodScorer = { scorePod: async (p) => { scored.push(p.podId); return { score: 9, reason: '' } } }
    const pods = [pod('cur'), pod('old', '99'), pod('mine'), pod('done')]
    const votes = await selectVotes('9', pods, rubric, 'conservative',
      filter({ ownPodIds: ['mine'], votedPodIds: ['done'] }), tracking)
    expect(scored).toEqual(['cur'])               // only the eligible pod is scored
    expect(votes.map((v) => v.podId)).toEqual(['cur'])
  })

  it('returns [] without scoring when the rubric is not vote-capable', async () => {
    let calls = 0
    const counting: PodScorer = { scorePod: async () => { calls++; return { score: 9, reason: '' } } }
    const votes = await selectVotes('9', [pod('a')], { ...rubric, canVote: false }, 'conservative', filter(), counting)
    expect(votes).toEqual([]); expect(calls).toBe(0)
  })

  it('aggressive strictness votes on mid-range pods that conservative skips', async () => {
    const votes = await selectVotes('9', [pod('mid')], rubric, 'aggressive', filter(), scorerOf({ mid: 6 }))
    expect(votes).toHaveLength(1)             // aggressive like>=6 → up
    expect(votes[0].direction).toBe('up')
  })

  it('boundary: score exactly at like→up, exactly at dislike→down, exactly between→skip', async () => {
    const votes = await selectVotes('9', [pod('at-like'), pod('at-dislike'), pod('between')], rubric, 'conservative',
      filter(), scorerOf({ 'at-like': 8, 'at-dislike': 4, between: 5 }))
    expect(votes.find((v) => v.podId === 'at-like')!.direction).toBe('up')      // >= like(8)
    expect(votes.find((v) => v.podId === 'at-dislike')!.direction).toBe('down') // <= dislike(4)
    expect(votes.find((v) => v.podId === 'between')).toBeUndefined()            // 5 → skip
  })

  it('tags every intent with kind=vote and the datanetId', async () => {
    const votes = await selectVotes('9', [pod('hi')], rubric, 'conservative', filter(), scorerOf({ hi: 10 }))
    expect(votes[0].kind).toBe('vote'); expect(votes[0].datanetId).toBe('9')
  })

  it('passes the strictness thresholds to the scorer (tiered/panel context)', async () => {
    let seen: unknown
    const capturing: PodScorer = { scorePod: async (_p, _r, t) => { seen = t; return { score: 9, reason: '' } } }
    await selectVotes('9', [pod('a')], rubric, 'conservative', filter(), capturing)
    expect(seen).toEqual({ like: 8, dislike: 4 })
  })

  it('carries the pod name onto the vote intent (dashboard shows names, not ids)', async () => {
    const votes = await selectVotes('9', [pod('hi')], rubric, 'conservative', filter(), scorerOf({ hi: 9 }))
    expect(votes[0].podName).toBe('pod hi')
  })

  it('threads a panel transcript from the score onto the vote intent', async () => {
    const panel = { panelists: [{ persona: 'bull', score: 9, argument: 'a' }], judge: { score: 9, reason: 'j' } }
    const withPanel: PodScorer = { scorePod: async () => ({ score: 9, reason: 'j', panel }) }
    const votes = await selectVotes('9', [pod('hi')], rubric, 'conservative', filter(), withPanel)
    expect(votes[0].panel).toEqual(panel)
  })

  it('omits panel on the intent when the score carried none', async () => {
    const votes = await selectVotes('9', [pod('hi')], rubric, 'conservative', filter(), scorerOf({ hi: 9 }))
    expect(votes[0].panel).toBeUndefined()
  })

  it('per-pod isolation: a scorer that throws on one pod skips it, others still vote', async () => {
    const flaky: PodScorer = {
      scorePod: async (p) => {
        if (p.podId === 'bad') throw new Error('No object generated: response did not match schema')
        return { score: 9, reason: 'ok' }
      },
    }
    const votes = await selectVotes('9', [pod('bad'), pod('good')], rubric, 'conservative', filter(), flaky)
    expect(votes.map((v) => v.podId)).toEqual(['good']) // bad skipped, good voted, no throw
  })
})
