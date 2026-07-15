// src/voter/weight.ts — size each vote from the wallet's REAL per-epoch voting-power
// budget instead of the legacy conviction×1e18 dust (1–10 power regardless of stake —
// a 59k-veREPPO wallet was spending 0.25% of its power per epoch and earning dust).
//
// PodManagerV2.vote() enforces `votes + votesCasted[voter] > votingPowerOf(voter) →
// revert InsufficientVotingPower` per epoch, so the spendable budget is exactly
// votingPower − votesCasted (src/reppo/votePower.ts reads both).
//
// Pacing: the remaining power is spread over the cycles left in the epoch
// (secondsRemaining / cadence), and each cycle's share over that cycle's vote cap, so
// the first cycle's pods don't drain the epoch and late pods still get real weight.
// Each vote then scales by conviction/10 — a 10 spends its full per-vote share, a 3
// spends 30% — clamped to the tracked remainder (overspending reverts on-chain and
// wastes gas).

export interface VoteWeigherInput {
  /** spendable power this epoch: votingPower − votesCasted (raw 18-dec). */
  remainingWei: bigint
  /** seconds until the current epoch ends (≥ 0). */
  secondsRemainingInEpoch: number
  /** scheduler cadence — how often a cycle runs. */
  cadenceHours: number
  /** per-cycle vote cap (config.budget.voteRateMaxPerCycle). */
  voteRateMaxPerCycle: number
  /** Optional spend horizon (config.budget.voteSpendHorizonHours × 3600): pace the
   *  remaining power over at most this many seconds instead of the whole remaining
   *  epoch. Vote weight resolves with a linear intra-epoch decay, so a short horizon
   *  FRONT-LOADS weight where it resolves highest; later pods still get the clamped
   *  remainder (never a reverting overspend). Absent ⇒ full-epoch pacing. */
  spendHorizonSeconds?: number
}

/** Returns the raw 18-dec weight to spend on one vote, or 0n when the epoch budget is
 *  exhausted (the caller must SKIP the vote, not sign a reverting tx). Stateful: each
 *  call draws down the budget. */
export type VoteWeigher = (conviction: number) => bigint

/** 1 veREPPO-power — below this a vote is dust (≈0 curation share), not worth gas. */
export const MIN_VOTE_WEIGHT_WEI = 10n ** 18n

export function createVoteWeigher(input: VoteWeigherInput): VoteWeigher {
  let remaining = input.remainingWei > 0n ? input.remainingWei : 0n
  const cadenceSec = Math.max(1, input.cadenceHours * 3600)
  // A spend horizon shrinks the pacing window: plan the budget over min(remaining epoch,
  // horizon) so the full power is committed within the horizon (front-loading).
  const paceSeconds = input.spendHorizonSeconds !== undefined
    ? Math.min(Math.max(0, input.secondsRemainingInEpoch), Math.max(1, input.spendHorizonSeconds))
    : Math.max(0, input.secondsRemainingInEpoch)
  const cyclesLeft = Math.max(1, Math.ceil(paceSeconds / cadenceSec))
  const votesPlanned = BigInt(Math.max(1, input.voteRateMaxPerCycle) * cyclesLeft)
  const perVoteWei = remaining / votesPlanned

  return (conviction: number): bigint => {
    const c = BigInt(Math.min(10, Math.max(1, Math.round(conviction))))
    let w = (perVoteWei * c) / 10n
    if (w < MIN_VOTE_WEIGHT_WEI) w = MIN_VOTE_WEIGHT_WEI
    if (w > remaining) w = remaining
    // Below the dust floor even after clamping ⇒ the epoch budget is spent; signal skip.
    if (w < MIN_VOTE_WEIGHT_WEI) return 0n
    remaining -= w
    return w
  }
}
