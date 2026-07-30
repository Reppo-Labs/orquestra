// src/dashboard/pnl.ts
import type { Snapshot } from './snapshot.js'
import type { DatanetYield } from '../voter/yield.js'

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

/** Lifetime earned/spent for ONE token symbol ('REPPO' or a datanet's native token,
 *  e.g. WOOD). Amounts stay in token units — USD conversion happens in prices.ts. */
export interface TokenFlow {
  symbol: string
  earned: number
  spent: number
  net: number
}

/** Fold the per-symbol claim sums and per-datanet mint spend into per-token flows.
 *
 *  Spend attribution: a mint's `reppoSpent` is denominated in whatever the datanet
 *  charges — REPPO on mainnet, the datanet's OWN token on robinhood (see
 *  executor.executeMint). The datanet → symbol mapping comes from the snapshot's
 *  datanetEconomics (nativeTokenSymbol); a datanet with no native token — or one
 *  missing from the economics list — stays on the REPPO leg, which matches the
 *  status-quo single-currency accounting.
 *
 *  The REPPO leg's earned side is claimed + claimable (derivePnl's earnedReppo);
 *  native-token claimables are unknown pre-claim on-chain, so native earned = claimed. */
export function deriveTokenFlows(
  reppoEarned: number,
  claimedTokens: { symbol: string; amount: number }[],
  spentByDatanet: { datanetId: string; amount: number }[],
  economics: Pick<DatanetYield, 'datanetId' | 'nativeTokenSymbol'>[],
): TokenFlow[] {
  const symbolOf = new Map(economics.map((e) => [e.datanetId, e.nativeTokenSymbol]))
  const flows = new Map<string, { earned: number; spent: number }>()
  const leg = (symbol: string) => {
    let f = flows.get(symbol)
    if (!f) { f = { earned: 0, spent: 0 }; flows.set(symbol, f) }
    return f
  }
  leg('REPPO').earned = reppoEarned
  for (const t of claimedTokens) leg(t.symbol).earned += t.amount
  for (const s of spentByDatanet) leg(symbolOf.get(s.datanetId) ?? 'REPPO').spent += s.amount
  return [...flows.entries()]
    .map(([symbol, f]) => ({ symbol, earned: f.earned, spent: f.spent, net: f.earned - f.spent }))
    .filter((f) => f.symbol === 'REPPO' || f.earned !== 0 || f.spent !== 0)
}
