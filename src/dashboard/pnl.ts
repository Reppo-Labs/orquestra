// src/dashboard/pnl.ts
import type { Snapshot } from './snapshot.js'
import type { ActivityEntry } from './activityLog.js'

export interface Pnl {
  claimedReppo: number
  claimableReppo: number
  earnedReppo: number
  spentReppo: number
  netReppo: number
  gasSpentEth: number
}

/** Pure PnL summary. claimed = Σ executed claim amounts in the log; claimable =
 *  still-unclaimed emissions in the latest snapshot; spent = REPPO on mints. */
export function derivePnl(snapshot: Snapshot, activity: ActivityEntry[]): Pnl {
  const claimedReppo = activity
    .filter((e) => e.kind === 'claim' && e.status === 'executed')
    .reduce((s, e) => s + (e.reppoClaimed ?? 0), 0)
  const claimableReppo = snapshot.emissionsDue.totalReppo
  const earnedReppo = claimedReppo + claimableReppo
  const spentReppo = snapshot.budget.mintReppoSpent
  const gasSpentEth = snapshot.budget.mintGasSpentEth + snapshot.budget.voteGasSpentEth + snapshot.budget.claimGasSpentEth
  return { claimedReppo, claimableReppo, earnedReppo, spentReppo, netReppo: earnedReppo - spentReppo, gasSpentEth }
}
