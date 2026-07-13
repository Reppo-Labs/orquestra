// src/rubric/types.test.ts — the VoteRubric/MintRubric split. The invariant "mint
// prompts never render economic yield" is a TYPE guarantee: currentYield exists only
// on VoteRubric; MintRubric structurally forbids it (`currentYield?: never`).
import { describe, it, expect } from 'vitest'
import type { DatanetYield } from '../voter/yield.js'
import type { CandidateScorer, CandidatePod } from '../adapter/types.js'
import { toVoteRubric, toMintRubric, type DatanetRubric, type VoteRubric, type MintRubric } from './types.js'

const loaded = (): DatanetRubric => ({
  datanetId: '9', name: 'D', goal: 'g', publisherSpec: 'p', voterRubric: 'v',
  subnetUuid: 'cm-9', canVote: true, canMint: true, status: 'ACTIVE',
  economics: { accessFeeReppo: 0, emissionsPerEpochReppo: 500, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'REPPO' },
})

const yld: DatanetYield = {
  datanetId: '9', emissionsPerEpochReppo: 500, epoch: 42,
  epochVoteVolume: 2_000_000, yieldPerVote: 500 / 2_000_000, uncontested: false,
}

describe('toVoteRubric', () => {
  it('attaches the cycle-computed yield to a CLONE; the shared rubric stays untouched', () => {
    const shared = loaded()
    const vote = toVoteRubric(shared, yld)
    expect(vote.economics.currentYield).toBe(yld)
    expect(vote).not.toBe(shared)
    expect(vote.economics).not.toBe(shared.economics)
    // the process-cached rubric (reused by the mint path + later cycles) never mutates
    expect('currentYield' in shared.economics).toBe(false)
  })

  it('without a yield produces a vote rubric with the key absent (RPC-less parity)', () => {
    const vote = toVoteRubric(loaded())
    expect('currentYield' in vote.economics).toBe(false)
  })
})

describe('toMintRubric', () => {
  it('strips currentYield from a yield-carrying vote rubric — key ABSENT, not undefined', () => {
    const vote = toVoteRubric(loaded(), yld)
    const mint = toMintRubric(vote)
    expect('currentYield' in mint.economics).toBe(false)
    // strip is non-destructive: the vote rubric keeps its yield
    expect(vote.economics.currentYield).toBe(yld)
  })

  it('passes a plain loaded rubric through with identical fields', () => {
    const shared = loaded()
    const mint = toMintRubric(shared)
    expect(mint).toEqual(shared)
    expect(mint.economics).not.toBe(shared.economics) // still a clone
  })
})

describe('compile-time guarantee (verified by `npm run typecheck`)', () => {
  it('a VoteRubric is not assignable where a MintRubric is expected', () => {
    const wantsMint = (_r: MintRubric): void => {}
    const proof = (vote: VoteRubric): void => {
      // @ts-expect-error — yield-capable rubric must never flow into the mint path
      wantsMint(vote)
    }
    expect(typeof proof).toBe('function')
  })

  it('a VoteRubric cannot be laundered through the DatanetRubric base type', () => {
    // The mint-safety wall must hold even when the yield-carrying rubric is first
    // widened to the base type (VoteRubric → DatanetRubric → MintRubric would
    // smuggle the yield past the direct check).
    const proof = (vote: VoteRubric): void => {
      // @ts-expect-error — a yield-capable rubric is NOT a plain loaded rubric
      const laundered: DatanetRubric = vote
      void laundered
    }
    expect(typeof proof).toBe('function')
  })

  it('currentYield can never be set on a MintRubric', () => {
    const proof = (mint: MintRubric): void => {
      // @ts-expect-error — MintRubric structurally forbids the vote-only yield field
      mint.economics.currentYield = yld
    }
    expect(typeof proof).toBe('function')
  })

  it('the real mint seam (CandidateScorer) rejects a VoteRubric', () => {
    const proof = (scorer: CandidateScorer, candidate: CandidatePod, vote: VoteRubric): void => {
      // @ts-expect-error — mint scoring takes MintRubric only; a VoteRubric does not compile
      void scorer.scoreCandidate(candidate, vote)
    }
    expect(typeof proof).toBe('function')
  })
})
