// src/voter/weight.test.ts
import { describe, it, expect } from 'vitest'
import { createVoteWeigher, MIN_VOTE_WEIGHT_WEI } from './weight.js'

const REPPO = 10n ** 18n

describe('createVoteWeigher', () => {
  it('spreads the remaining power over cycles left × per-cycle cap, scaled by conviction', () => {
    // 60k power, 24h left at 1h cadence → 24 cycles, cap 10 → 240 planned votes.
    // perVote = 250 REPPO; conviction 10 spends the full share, 5 spends half.
    const weigh = createVoteWeigher({
      remainingWei: 60_000n * REPPO,
      secondsRemainingInEpoch: 24 * 3600,
      cadenceHours: 1,
      voteRateMaxPerCycle: 10,
    })
    expect(weigh(10)).toBe(250n * REPPO)
    expect(weigh(5)).toBe(125n * REPPO)
    expect(weigh(1)).toBe(25n * REPPO)
  })

  it('treats a nearly-over epoch as one final cycle (spend, do not stall)', () => {
    // 10 seconds left → cyclesLeft floors at 1 → perVote = remaining / cap.
    const weigh = createVoteWeigher({
      remainingWei: 100n * REPPO,
      secondsRemainingInEpoch: 10,
      cadenceHours: 1,
      voteRateMaxPerCycle: 10,
    })
    expect(weigh(10)).toBe(10n * REPPO)
  })

  it('floors each vote at 1 veREPPO-power instead of signing dust', () => {
    // perVote = 0.5 REPPO → conviction 1 would be 0.05 → floored to the 1-power minimum.
    const weigh = createVoteWeigher({
      remainingWei: 120n * REPPO,
      secondsRemainingInEpoch: 24 * 3600,
      cadenceHours: 1,
      voteRateMaxPerCycle: 10,
    })
    expect(weigh(1)).toBe(MIN_VOTE_WEIGHT_WEI)
  })

  it('never overspends: clamps to the remainder, then signals exhaustion with 0n', () => {
    const weigh = createVoteWeigher({
      remainingWei: 3n * REPPO,
      secondsRemainingInEpoch: 1,
      cadenceHours: 1,
      voteRateMaxPerCycle: 1, // perVote = 3 REPPO
    })
    expect(weigh(10)).toBe(3n * REPPO) // spends everything
    expect(weigh(10)).toBe(0n) // budget gone → skip signal, NOT a reverting tx
  })

  it('returns 0n immediately when the wallet has no spendable power', () => {
    const weigh = createVoteWeigher({
      remainingWei: 0n,
      secondsRemainingInEpoch: 24 * 3600,
      cadenceHours: 1,
      voteRateMaxPerCycle: 10,
    })
    expect(weigh(10)).toBe(0n)
  })

  it('clamps out-of-range convictions into 1..10', () => {
    const weigh = createVoteWeigher({
      remainingWei: 1_000n * REPPO,
      secondsRemainingInEpoch: 3600,
      cadenceHours: 1,
      voteRateMaxPerCycle: 10, // perVote = 100 REPPO
    })
    expect(weigh(99)).toBe(100n * REPPO) // → 10
    expect(weigh(-5)).toBe(10n * REPPO) // → 1
  })

  it('a partial remainder below the floor is left unspent (0n), never a dust vote', () => {
    // remaining 0.5 REPPO < 1-power floor → 0n from the first call.
    const weigh = createVoteWeigher({
      remainingWei: REPPO / 2n,
      secondsRemainingInEpoch: 3600,
      cadenceHours: 1,
      voteRateMaxPerCycle: 1,
    })
    expect(weigh(10)).toBe(0n)
  })
})
