// src/learn/econStats.ts
// The economics half of the hybrid reflection — deterministic REPPO aggregates over
// the last N epochs' econ_epochs buckets. Numbers only, same anti-injection posture
// as stats.ts: no string from pods/claims ever reaches the reflection LLM.
import type { EconEpochRow } from './store.js'
import type { DatanetYield } from '../voter/yield.js'

export interface EconStats {
  datanetId: string
  epochsCovered: number             // distinct epochs with any data in the window
  mintCostReppo: number
  mintCount: number
  ownerClaimedReppo: number
  mintRoiPct: number | null         // owner/cost ×100 rounded; null when cost is 0
  voterClaimedReppo: number
  votesCast: number
  voterReppoPerVote: number | null  // voter/votes; null when 0 votes
  latestYieldPerVote: number | null // from the latest snapshot's datanetEconomics
  latestUncontested: boolean
}

/** Pure: aggregate the (already windowed by the caller, e.g. readEconEpochs lastN)
 *  econ_epochs rows for a datanet into economics stats fed to reflection. */
export function computeEconStats(datanetId: string, rows: EconEpochRow[], latestYield?: DatanetYield): EconStats {
  let mintCostReppo = 0
  let mintCount = 0
  let ownerClaimedReppo = 0
  let voterClaimedReppo = 0
  let votesCast = 0
  const epochsWithData = new Set<number>()

  for (const r of rows) {
    mintCostReppo += r.mintCostReppo
    mintCount += r.mintCount
    ownerClaimedReppo += r.ownerClaimedReppo
    voterClaimedReppo += r.voterClaimedReppo
    votesCast += r.votesCast
    const hasData = r.mintCostReppo !== 0 || r.mintCount !== 0 || r.ownerClaimedReppo !== 0 ||
      r.voterClaimedReppo !== 0 || r.votesCast !== 0
    if (hasData) epochsWithData.add(r.epoch)
  }

  return {
    datanetId,
    epochsCovered: epochsWithData.size,
    mintCostReppo,
    mintCount,
    ownerClaimedReppo,
    mintRoiPct: mintCostReppo > 0 ? Math.round((ownerClaimedReppo / mintCostReppo) * 100) : null,
    voterClaimedReppo,
    votesCast,
    voterReppoPerVote: votesCast > 0 ? voterClaimedReppo / votesCast : null,
    latestYieldPerVote: latestYield?.yieldPerVote ?? null,
    latestUncontested: latestYield?.uncontested ?? false,
  }
}
