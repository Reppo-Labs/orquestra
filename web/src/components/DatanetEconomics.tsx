import type { Snapshot } from '../api'
import { netLabel } from '../lib/format'

/** Per-datanet emission economics from the latest cycle snapshot: emission rate,
 *  current-epoch vote volume, and yield (REPPO per unit of vote weight). Rows are
 *  fresh each cycle; snapshots from before the feature carry no array and render
 *  nothing. */
export function DatanetEconomics({ snapshot, netNames }: {
  snapshot: Snapshot | null
  netNames: Record<string, string>
}) {
  const rows = snapshot?.datanetEconomics ?? []
  if (!rows.length) return null
  return (
    <div>
      <div className="sec-head"><h2>Datanet economics</h2><div className="rule" /></div>
      <div className="panel-box">
        <table>
          <thead><tr><th>Datanet</th><th>Emissions</th><th>Epoch vote volume</th><th>Yield / vote</th></tr></thead>
          <tbody>
            {rows.map((y) => (
              <tr key={y.datanetId}>
                <td className="net-cell">{netLabel(y.datanetId, netNames)}</td>
                <td>{y.emissionsPerEpochReppo > 0
                  ? `${y.emissionsPerEpochReppo} REPPO/epoch`
                  : y.nativeTokenSymbol ? `${y.nativeTokenSymbol} (native token)` : '0 — pays nothing'}</td>
                <td>{y.epochVoteVolume === null
                  ? <span className="faint">unavailable</span>
                  : y.uncontested ? <span className="pos">0 — uncontested</span>
                  : `${y.epochVoteVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })}${y.epoch !== null ? ` (epoch ${y.epoch})` : ''}`}</td>
                <td className="mono">{y.yieldPerVote === null ? '—' : y.yieldPerVote.toExponential(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
