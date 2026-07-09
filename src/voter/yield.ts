// src/voter/yield.ts
// Per-datanet emission yield: REPPO emitted per unit of CURRENT-epoch vote weight.
// Reppo has no depletable reward pool — emissions are a per-epoch flow split by the
// epoch's vote weight — so "which datanets still pay" is a yield question, not a
// pool-balance one (docs/superpowers/specs/2026-07-09-datanet-emission-yield-design.md).
// The catalog's upVoteVolume/downVoteVolume are LIFETIME tallies and deliberately
// unused here: rate ÷ lifetime volume decays with datanet age and is not what a vote
// earns. Volume comes from the on-chain per-epoch views instead (src/reppo/epochVotes.ts).
// The rate itself comes from the process-lifetime rubric cache — acceptable (rates
// change rarely); the volume side is live from chain each cycle.

export interface DatanetYield {
  datanetId: string
  /** REPPO emitted per epoch (platform catalog rate, from rubric.economics). */
  emissionsPerEpochReppo: number
  /** Epoch the volume was read at; null when the on-chain read was unavailable. */
  epoch: number | null
  /** Σ up+down vote weight this epoch, REPPO-scaled (raw / 1e18); null = RPC unavailable. */
  epochVoteVolume: number | null
  /** rate ÷ epochVoteVolume; null when volume is 0 (uncontested), rate is 0, or unavailable. */
  yieldPerVote: number | null
  /** true when the epoch-volume read succeeded and is 0 — nobody has voted yet this epoch. */
  uncontested: boolean
  /** set when the datanet emits a non-REPPO token: rate is 0 but it still pays. */
  nativeTokenSymbol?: string
}

/** The economics subset computeYield reads (structural — avoids importing DatanetRubric,
 *  which itself imports this module for the optional currentYield field). */
export interface YieldEconomics { emissionsPerEpochReppo: number; nativeTokenSymbol: string }

export function computeYield(
  datanetId: string,
  economics: YieldEconomics,
  epochVotes: { epoch: number; totalRaw: bigint } | null,
): DatanetYield {
  const rate = economics.emissionsPerEpochReppo
  const native = economics.nativeTokenSymbol && economics.nativeTokenSymbol.toUpperCase() !== 'REPPO'
    ? economics.nativeTokenSymbol
    : undefined
  const base = { datanetId, emissionsPerEpochReppo: rate, ...(native ? { nativeTokenSymbol: native } : {}) }
  if (epochVotes === null) {
    return { ...base, epoch: null, epochVoteVolume: null, yieldPerVote: null, uncontested: false }
  }
  const volume = Number(epochVotes.totalRaw) / 1e18
  const uncontested = volume === 0
  return {
    ...base,
    epoch: epochVotes.epoch,
    epochVoteVolume: volume,
    yieldPerVote: uncontested || rate === 0 ? null : rate / volume,
    uncontested,
  }
}

/** One-line human summary — the info activity row + stderr breadcrumb. (The token
 *  symbol may appear HERE — activity reasons are display-only; prompts use
 *  buildEconomicsBlock, which is numerics-only.) */
export function formatYieldLine(y: DatanetYield): string {
  const rate = y.emissionsPerEpochReppo > 0
    ? `${y.emissionsPerEpochReppo} REPPO/epoch`
    : y.nativeTokenSymbol
      ? `emits ${y.nativeTokenSymbol} (non-REPPO token)`
      : 'pays nothing this epoch'
  if (y.epochVoteVolume === null) return `${rate} · yield unavailable (no RPC read)`
  if (y.uncontested) return `${rate} · epoch ${y.epoch} vote volume 0 — uncontested`
  const vol = y.epochVoteVolume.toLocaleString('en-US', { maximumFractionDigits: 0 })
  const yld = y.yieldPerVote !== null ? ` · yield ${y.yieldPerVote.toExponential(2)}/vote` : ''
  return `${rate} · epoch ${y.epoch} vote volume ${vol}${yld}`
}
