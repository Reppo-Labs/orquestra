// src/dashboard/pnl.ts
import type { Snapshot } from './snapshot.js'

export interface Pnl {
  claimedReppo: number
  claimableReppo: number
  earnedReppo: number
  spentReppo: number
  netReppo: number
  gasSpentEth: number
}

/** Pure PnL summary. `claimedReppo` is the lifetime sum of executed claims — the
 *  caller MUST pass the unbounded total (activityLog.sumClaimedReppo), NOT a sum
 *  over a windowed `readActivity` slice: a capped window drops old claims while
 *  cumulative mint spend is never truncated, so net would read falsely negative.
 *  claimable = still-unclaimed emissions in the latest snapshot; spent = REPPO
 *  on mints. */
export function derivePnl(snapshot: Snapshot, claimedReppo: number): Pnl {
  const claimableReppo = snapshot.emissionsDue.totalReppo
  const earnedReppo = claimedReppo + claimableReppo
  const spentReppo = snapshot.budget.mintReppoSpent
  const gasSpentEth = snapshot.budget.mintGasSpentEth + snapshot.budget.voteGasSpentEth + snapshot.budget.claimGasSpentEth
  return { claimedReppo, claimableReppo, earnedReppo, spentReppo, netReppo: earnedReppo - spentReppo, gasSpentEth }
}
