import type { Pnl, Earn } from '../api'
import { fmt } from '../lib/format'

/** Prominent Overview panel: the node's emissions at a glance — all-time claimed +
 *  currently claimable REPPO. Both come straight from /api/pnl (claimedReppo = sum of
 *  executed on-chain claims; claimableReppo = live emissions-due total). Earned = sum.
 *  Non-REPPO emissions (e.g. LBM from Litebeam) are shown per-token, NOT summed into REPPO. */
export function EmissionsSummary({ pnl, earn }: { pnl: Pnl | null; earn?: Earn | null }) {
  if (!pnl) return null
  const tokens = (earn?.claimedTokens ?? []).filter((t) => t.amount > 0)
  return (
    <div className="panel-box">
      <div className="cards">
        <div className="card hero">
          <div className="k">Claimed (all-time)</div>
          <div className="v">{fmt(pnl.claimedReppo)} REPPO</div>
        </div>
        <div className="card hero">
          <div className="k">Claimable now</div>
          <div className="v"><span className={pnl.claimableReppo > 0 ? 'pos' : ''}>{fmt(pnl.claimableReppo)} REPPO</span></div>
        </div>
        {tokens.map((t) => (
          <div className="card" key={t.symbol}>
            <div className="k">Claimed {t.symbol}</div>
            <div className="v"><span className="pos">{fmt(t.amount)} {t.symbol}</span></div>
          </div>
        ))}
      </div>
      <div className="muted" style={{ marginTop: '0.5rem' }}>
        Earned total: {fmt(pnl.earnedReppo)} REPPO{tokens.length ? ' (+ native tokens shown separately)' : ''} · claims run automatically each cycle
      </div>
    </div>
  )
}
