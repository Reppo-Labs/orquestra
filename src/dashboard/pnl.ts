// src/dashboard/pnl.ts
import type { Snapshot } from './snapshot.js'

export interface Pnl {
  claimedReppo: number
  claimableReppo: number
  /** still-unclaimed (pod,epoch) pairs. Under on-chain detection the amount is unknown
   *  pre-claim, so claimableReppo can read 0 while pairs are pending. */
  claimablePairs: number
  earnedReppo: number
  spentReppo: number
  netReppo: number
  gasSpentEth: number
}

/** Pure PnL summary. Both `claimedReppo` and `mintReppoSpent` MUST be lifetime
 *  unbounded totals from the activity log (sumClaimedReppo / sumMintReppoSpent) —
 *  NOT the rolling budget-ledger values which reset each horizon window. Using the
 *  ledger's mintReppoSpent causes a misleading flip from negative to strongly positive
 *  at each horizon rollover while claimed stays lifetime. */
export function derivePnl(snapshot: Snapshot, claimedReppo: number, mintReppoSpent: number): Pnl {
  const claimableReppo = snapshot.emissionsDue.totalReppo
  const claimablePairs = snapshot.emissionsDue.pods.length
  const earnedReppo = claimedReppo + claimableReppo
  const spentReppo = mintReppoSpent
  const gasSpentEth = snapshot.budget.mintGasSpentEth + snapshot.budget.voteGasSpentEth + snapshot.budget.claimGasSpentEth
  return { claimedReppo, claimableReppo, claimablePairs, earnedReppo, spentReppo, netReppo: earnedReppo - spentReppo, gasSpentEth }
}
