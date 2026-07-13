// src/dashboard/datanetPnl.ts
// Per-datanet profit — the single most actionable number a node operator has: "Datanet 2
// returned 205%; Datanet 1 returned 0% over 10 votes — turn it off?".
//
// SPENT  = REPPO paid to mint (activity kind='mint', status='executed', reppoSpent).
// EARNED = REPPO claimed back (activity kind='claim', status='executed', reppoClaimed) —
//          both OWNER claims (our pods' publisher emissions) and VOTER claims (curating
//          others' pods), which is why a datanet can earn with zero mint spend.
// Both are LIFETIME sums (see readDatanetTotals) — a windowed spend/earn pair would make
// ROI drift as the log grows.
//
// Deliberately independent of src/learn (econStats.ts computes a similar mintRoiPct, but
// only over the learn feature's epoch buckets, which exist only when learning is enabled
// and the epoch read succeeded). This view must work on any node.
import { readDatanetTotals, type DatanetTotals } from './activityLog.js'

export interface DatanetPnl {
  datanetId: string
  reppoSpent: number
  reppoEarned: number
  /** earned − spent. Negative = this datanet is costing the operator money. */
  net: number
  /** earned / spent × 100, rounded. NULL when nothing was spent — a 0-spend datanet has
   *  no return ratio (dividing would be ∞ or a fake 0), and the UI must say "—", not "0%".
   *  A vote-only datanet is judged on `net` + `votesCast`, not on roi. */
  roi: number | null
  votesCast: number
  mintsExecuted: number
}

/** Pure: totals → P&L rows, worst net first (the datanet an operator should look at). */
export function computeDatanetPnl(totals: DatanetTotals[]): DatanetPnl[] {
  return totals
    .map((t) => ({
      datanetId: t.datanetId,
      reppoSpent: t.reppoSpent,
      reppoEarned: t.reppoEarned,
      net: t.reppoEarned - t.reppoSpent,
      roi: t.reppoSpent > 0 ? Math.round((t.reppoEarned / t.reppoSpent) * 100) : null,
      votesCast: t.votesCast,
      mintsExecuted: t.mintsExecuted,
    }))
    .sort((a, b) => a.net - b.net || a.datanetId.localeCompare(b.datanetId, undefined, { numeric: true }))
}

/** Read model for GET /api/datanet-pnl. */
export function readDatanetPnl(dataDir: string): DatanetPnl[] {
  return computeDatanetPnl(readDatanetTotals(dataDir))
}
