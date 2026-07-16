import type { DatanetYield, Snapshot } from '../api'
import { netLabel } from '../lib/format'

/** Rank for the "best places to vote" board: uncontested datanets first (nobody has
 *  voted this epoch — the first voter takes the whole epoch's emissions), then by
 *  yield per vote, descending. */
function rank(a: DatanetYield, b: DatanetYield): number {
  if (a.uncontested !== b.uncontested) return a.uncontested ? -1 : 1
  return (b.yieldPerVote ?? 0) - (a.yieldPerVote ?? 0)
}

/** Overview leaderboard: the top emission-yield datanets from the latest cycle
 *  snapshot — "where does a vote earn the most right now". The full per-datanet
 *  economics live on each Strategy-tab card (next to the voteShare control they
 *  inform); this card is the glanceable summary with a click-through. Rows are fresh
 *  each cycle; pre-feature snapshots carry no array and render nothing. */
export function DatanetEconomics({ snapshot, netNames, onGoToStrategy }: {
  snapshot: Snapshot | null
  netNames: Record<string, string>
  /** Jump to the Strategy tab; with a datanetId, scroll to + flash that datanet's card.
   *  (The board ranks CONFIGURED datanets only — the row's action is tuning its vote
   *  share, never "add". Discovery of new datanets is the Learning tab's job.) */
  onGoToStrategy: (datanetId?: string) => void
}) {
  const all = snapshot?.datanetEconomics ?? []
  // Only datanets that pay and whose volume read succeeded can be ranked.
  const rankable = all
    .filter((y) => (y.emissionsPerEpochReppo > 0 || y.nativeTokenSymbol) && y.epochVoteVolume !== null)
    .sort(rank)
  const top = rankable.slice(0, 3)
  const unavailable = all.filter((y) => y.epochVoteVolume === null).length
  if (!all.length) return null
  return (
    // Fragment, not a wrapper div: .sec-head:first-child would otherwise see this
    // header as the top of the page and collapse its 32px section margin to 6px,
    // breaking the even rhythm between Overview sections.
    <>
      <div className="sec-head">
        <h2>Best places to vote</h2>
        <span className="muted" style={{ fontSize: 12 }}>among your configured datanets</span>
        <div className="rule" />
        <button className="link-btn" onClick={() => onGoToStrategy()}>adjust vote shares →</button>
      </div>
      <div>
        {top.length ? (
          <div className="yield-board">
            {top.map((y, i) => (
              <button key={y.datanetId} className="yield-row" onClick={() => onGoToStrategy(y.datanetId)}
                title="open this datanet's card on the Strategy tab">

                <span className="yield-rank mono">#{i + 1}</span>
                <span className="yield-net">{netLabel(y.datanetId, netNames)}</span>
                {y.uncontested
                  ? <span className="econ-badge uncontested">uncontested — first voter takes epoch {y.epoch}</span>
                  // yieldPerVote is null for native-token datanets (rate 0 in REPPO terms)
                  // even when contested — never assert non-null here (crashed the SPA).
                  : y.yieldPerVote === null
                    ? <span className="yield-num mono muted">pays {y.nativeTokenSymbol ?? '?'} (native)</span>
                    : <span className="yield-num mono">⚡ {y.yieldPerVote.toExponential(2)}/vote</span>}
                <span className="yield-ctx muted">
                  {y.emissionsPerEpochReppo > 0
                    ? `${y.emissionsPerEpochReppo.toLocaleString()} REPPO/epoch`
                    : `${y.nativeTokenSymbol} (native)`}
                  {!y.uncontested && y.epochVoteVolume !== null
                    ? ` · vol ${y.epochVoteVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                    : ''}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="muted">no rankable datanets this cycle{unavailable ? ` (${unavailable} unavailable)` : ''}</div>
        )}
        {top.length > 0 && unavailable > 0 && (
          <div className="muted" style={{ marginTop: '0.5rem', fontSize: 12 }}>
            {unavailable} datanet{unavailable > 1 ? 's' : ''} unavailable this cycle (volume read failed) — details on the Strategy tab
          </div>
        )}
      </div>
    </>
  )
}
