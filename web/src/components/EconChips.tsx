import type { DatanetYield } from '../api'
import { fmt, fmtPerVote } from '../lib/format'

/** "What does this datanet pay?" — the read-only economics chips for one datanet row.
 *  Lifted out of the old StrategyTab card so the Datanets table can show it beside the
 *  P&L and the health state (earning / working / paying, one row).
 *
 *  Heat is RELATIVE to the best yield across THIS node's datanets this cycle (hot ≥ ⅔ of
 *  max, warm ≥ ⅓) — not an absolute scale, and never a profit signal: orange means "pays
 *  more than your other datanets right now", not "you are making money". */
export function EconChips({ y, maxYield }: { y?: DatanetYield; maxYield: number }) {
  if (!y) return <span className="faint">—</span> // pre-feature snapshot, or not reached this cycle
  const rate = y.emissionsPerEpochReppo > 0
    ? `${fmt(y.emissionsPerEpochReppo)} REPPO/epoch`
    : y.nativeTokenSymbol ? `${y.nativeTokenSymbol} (native)` : 'pays nothing'
  const heat = y.yieldPerVote !== null && maxYield > 0
    ? y.yieldPerVote >= maxYield * (2 / 3) ? 'hot' : y.yieldPerVote >= maxYield / 3 ? 'warm' : ''
    : ''
  return (
    <div className="econ-chips">
      <span className={`econ-chip ${y.emissionsPerEpochReppo > 0 || y.nativeTokenSymbol ? '' : 'off'}`}>{rate}</span>
      {y.epochVoteVolume === null ? (
        <span className="econ-chip off" title={y.unavailableReason ? `volume read failed: ${y.unavailableReason}` : 'no RPC configured on this node'}>
          yield unavailable{y.unavailableReason ? ' (read failed)' : ''}
        </span>
      ) : y.uncontested ? (
        <span className="econ-badge uncontested" title={`nobody has voted in epoch ${y.epoch} yet — the first voter takes the epoch's emissions`}>
          uncontested · epoch {y.epoch}
        </span>
      ) : y.yieldPerVote !== null ? (
        <span className={`econ-chip yield ${heat}`}
          title={`epoch ${y.epoch}: ${fmt(y.epochVoteVolume)} votes so far · exactly ${y.yieldPerVote} REPPO per vote`}>
          ⚡ {fmtPerVote(y.yieldPerVote)}
        </span>
      ) : null /* rate 0 (native/pays-nothing): the rate chip already says it — no dead "⚡ —" chip */}
    </div>
  )
}
