import type { Pnl } from '../api'
import { fmt } from '../lib/format'

/** Prominent Overview panel: the node's emissions at a glance — all-time claimed +
 *  currently claimable REPPO. Both come straight from /api/pnl (claimedReppo = sum of
 *  executed on-chain claims; claimableReppo = live emissions-due total). Earned = sum. */
export function EmissionsSummary({ pnl }: { pnl: Pnl | null }) {
  if (!pnl) return null
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
      </div>
      <div className="muted" style={{ marginTop: '0.5rem' }}>
        Earned total: {fmt(pnl.earnedReppo)} REPPO · claims run automatically each cycle
      </div>
    </div>
  )
}
