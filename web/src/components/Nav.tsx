import type { ReactNode } from 'react'
import type { DashData } from '../api'
import { fmt, epochLabel, sign } from '../lib/format'

export type TabId = 'overview' | 'strategy' | 'chat' | 'activity' | 'learning'

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'strategy', label: 'Strategy' },
  { id: 'chat', label: 'Assistant' },
  { id: 'activity', label: 'Activity' },
  { id: 'learning', label: 'Learning' },
]

export function Nav({ data, asof, tab, onTab, activityCount }: {
  data: DashData | null
  asof: string
  tab: TabId
  onTab: (t: TabId) => void
  activityCount: number
}) {
  const snap = data?.snapshot
  const pnl = data?.pnl
  const cfg = data?.config
  const ticks: { k: string; v: ReactNode }[] = [
    { k: 'Epoch', v: snap ? epochLabel(snap.epoch) : '—' },
    { k: 'Net REPPO', v: pnl ? <span className={sign(pnl.netReppo)}>{fmt(pnl.netReppo)}</span> : '—' },
    { k: 'REPPO', v: snap ? fmt(snap.balance.reppo) : '—' },
    { k: 'veREPPO', v: snap ? fmt(snap.balance.veReppo) : '—' },
    { k: 'Claimable', v: pnl ? <span className={pnl.claimableReppo > 0 ? 'pos' : ''}>{fmt(pnl.claimableReppo)}</span> : '—' },
    { k: 'Cadence', v: cfg ? `${cfg.cadenceHours}h` : '—' },
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
        </div>
      </div>
      <div className="ticker">
        <div className="ticker-inner">
          {ticks.map((t) => (
            <span className="tick" key={t.k}>
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
