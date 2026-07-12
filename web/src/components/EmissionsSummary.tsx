import { useState } from 'react'
import type { Pnl, Earn, Snapshot } from '../api'
import { fmt, netLabel } from '../lib/format'

/** Prominent Overview panel: the node's emissions at a glance — all-time claimed +
 *  currently claimable REPPO. Both come straight from /api/pnl (claimedReppo = sum of
 *  executed on-chain claims; claimableReppo = live emissions-due total). Earned = sum.
 *  Non-REPPO emissions (e.g. LBM from Litebeam) are shown per-token, NOT summed into REPPO.
 *  The claimable aggregate expands into the per-pod payout list (snapshot emissionsDue). */
export function EmissionsSummary({ pnl, earn, snapshot, netNames }: {
  pnl: Pnl | null
  earn?: Earn | null
  snapshot?: Snapshot | null
  netNames?: Record<string, string>
}) {
  const [showPods, setShowPods] = useState(false)
  if (!pnl) return null
  const tokens = (earn?.claimedTokens ?? []).filter((t) => t.amount > 0)
  // tolerate pre-feature snapshots that carry no emissionsDue at all
  const pods = snapshot?.emissionsDue?.pods ?? []
  return (
    <div className="panel-box">
      <div className="cards">
        <div className="card hero">
          <div className="k">Claimed (all-time)</div>
          <div className="v">{fmt(pnl.claimedReppo)} REPPO</div>
        </div>
        <div className="card hero">
          <div className="k">Claimable now</div>
          <div className="v">
            <span className={pnl.claimableReppo > 0 || (pnl.claimablePairs ?? 0) > 0 ? 'pos' : ''}>
              {fmt(pnl.claimableReppo)} REPPO
              {(pnl.claimablePairs ?? 0) > 0 ? ` · ${pnl.claimablePairs} pending` : ''}
            </span>
          </div>
        </div>
        {tokens.map((t) => (
          <div className="card" key={t.symbol}>
            <div className="k">Claimed {t.symbol}</div>
            <div className="v"><span className="pos">{fmt(t.amount)} {t.symbol}</span></div>
          </div>
        ))}
      </div>
      <div className="muted" style={{ marginTop: '0.5rem' }}>
        Earned total: {fmt(pnl.earnedReppo)} REPPO{tokens.length ? ' (+ native tokens shown separately)' : ''}. Claims run automatically each cycle.
        {pods.length > 0 && (
          <>
            {' '}
            <button
              className="link-btn"
              aria-expanded={showPods}
              aria-controls="emissions-pods"
              onClick={() => setShowPods((s) => !s)}
            >
              {showPods ? 'hide' : 'show'} {pods.length} pod payout{pods.length === 1 ? '' : 's'} due
            </button>
          </>
        )}
      </div>
      {showPods && pods.length > 0 && (
        <div id="emissions-pods" style={{ marginTop: '0.6rem' }}>
          <table>
            <thead><tr><th>Pod</th><th>Datanet</th><th>Epoch</th><th>REPPO due</th></tr></thead>
            <tbody>
              {pods.map((p) => (
                <tr key={`${p.podId}-${p.epoch}`}>
                  <td className="mono net-cell" title={p.podId}>{p.podId}</td>
                  <td className="net-cell" title={netLabel(p.datanetId, netNames ?? {})}>{netLabel(p.datanetId, netNames ?? {})}</td>
                  <td className="mono">{String(p.epoch)}</td>
                  {/* 0 is honest: on-chain detection knows a payout is due before its amount */}
                  <td className="mono">{p.reppo > 0 ? <span className="pos">{fmt(p.reppo)}</span> : <span className="faint">pending</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
