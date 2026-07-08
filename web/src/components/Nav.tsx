import type { ReactNode } from 'react'
import type { DashData } from '../api'
import { fmt, epochLabel, sign } from '../lib/format'
import { Tip } from './Tip'
import { RunNowButton } from './RunNowButton'

export type TabId = 'overview' | 'strategy' | 'chat' | 'activity' | 'learning'

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'strategy', label: 'Strategy' },
  { id: 'chat', label: 'Assistant' },
  { id: 'activity', label: 'Activity' },
  { id: 'learning', label: 'Learning' },
]

export function Nav({ data, asof, tab, onTab, activityCount, onRefresh }: {
  data: DashData | null
  asof: string
  tab: TabId
  onTab: (t: TabId) => void
  activityCount: number
  /** Refresh the dashboard after a manual "run now" trigger. */
  onRefresh: () => void
}) {
  const snap = data?.snapshot
  const pnl = data?.pnl
  const cfg = data?.config
  const ticks: { k: ReactNode; id: string; v: ReactNode }[] = [
    { id: 'Epoch', k: 'Epoch', v: snap ? epochLabel(snap.epoch) : '—' },
    { id: 'Net REPPO', k: 'Net REPPO', v: pnl ? <span className={sign(pnl.netReppo)}>{fmt(pnl.netReppo)}</span> : '—' },
    { id: 'REPPO', k: 'REPPO', v: snap ? fmt(snap.balance.reppo) : '—' },
    {
      id: 'veREPPO',
      k: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          veREPPO
          <Tip label="veREPPO explained">
            <b>veREPPO ≠ locked REPPO</b>
            <p style={{ margin: '6px 0 0' }}>
              The protocol applies a duration-based multiplier — longer locks earn
              proportionally more voting power. The result can exceed the amount
              of REPPO you locked.
            </p>
          </Tip>
        </span>
      ),
      v: snap ? fmt(snap.balance.veReppo) : '—',
    },
    { id: 'Claimable', k: 'Claimable', v: pnl ? <span className={pnl.claimableReppo > 0 || (pnl.claimablePairs ?? 0) > 0 ? 'pos' : ''}>{(pnl.claimablePairs ?? 0) > 0 && pnl.claimableReppo === 0 ? `${pnl.claimablePairs} pending` : fmt(pnl.claimableReppo)}</span> : '—' },
    { id: 'Cadence', k: 'Cadence', v: cfg ? `${cfg.cadenceHours}h` : '—' },
  ]
  return (
    <>
      <div className="nav">
        <div className="nav-inner">
          <div className="brand">
            <div className="brand-mark">◆</div>
            <span className="brand-name">orquestra <span className="dim">/ node</span></span>
          </div>
          <div className="nav-spacer" />
          <span className="nav-asof">{asof}</span>
          <RunNowButton onRefresh={onRefresh} />
        </div>
      </div>
      <div className="ticker">
        <div className="ticker-inner">
          {ticks.map((t) => (
            <span className="tick" key={t.id}>
              <span className="k">{t.k}</span>
              <span className="v tnum">{t.v}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="tabs-wrap">
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => onTab(t.id)}>
              {t.label}
              {t.id === 'activity' && activityCount > 0 && <span className="count">{activityCount}</span>}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
