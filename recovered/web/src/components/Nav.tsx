import type { ReactNode } from 'react'
import type { DashData } from '../api'
import type { Severity } from '../lib/alerts'
import { fmt, sign } from '../lib/format'
import { AlertBadge } from './AlertsPanel'
import { PauseControl } from './PauseControl'
import { RunNowButton } from './RunNowButton'

// THREE tabs. Six was a filing cabinet — Overview, Strategy, Assistant, Activity, Health,
// Learning — half of which a non-technical operator has no reason to open on a good day.
// Home = am I making money, and what do I do. Datanets = the one thing that changes that.
// Assistant = ask for it in words. Diagnostics still exists (DiagnosticsTab) but it is a
// LINK, not a tab: its prominence should match how often it is actually needed.
export type TabId = 'home' | 'datanets' | 'assistant' | 'diagnostics'

const TABS: { id: TabId; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'datanets', label: 'Datanets' },
  { id: 'assistant', label: 'Assistant' },
]

export function Nav({ data, asof, tab, onTab, paused, onPauseChange, onRefresh, alertCount, alertWorst, onOpenAlerts }: {
  data: DashData | null
  asof: string
  tab: TabId
  onTab: (t: TabId) => void
  paused: boolean
  onPauseChange: (paused: boolean) => void
  /** Refresh the dashboard after a manual "run now" trigger. */
  onRefresh: () => void
  /** Unresolved alerts, INCLUDING dismissed ones — a node broken for three days must say so
   *  from every tab, not only from the one the operator never opens. */
  alertCount: number
  alertWorst: Severity | null
  onOpenAlerts: () => void
}) {
  const snap = data?.snapshot
  const pnl = data?.pnl
  // The ticker now says what an operator would say out loud: am I up or down, what does the
  // node hold, how often does it run. Epoch, veREPPO and claimable moved into Home's details
  // disclosure — they are mechanics, not money.
  const ticks: { k: ReactNode; id: string; v: ReactNode }[] = [
    { id: 'Net REPPO', k: 'Net REPPO', v: pnl ? <span className={sign(pnl.netReppo)}>{fmt(pnl.netReppo)}</span> : '—' },
    { id: 'REPPO balance', k: 'REPPO balance', v: snap ? fmt(snap.balance.reppo) : '—' },
    { id: 'Cadence', k: 'Cadence', v: data?.config?.cadenceHours ? `${data.config.cadenceHours}h` : '—' },
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
          {/* Where the operator cannot miss it. Clicking goes to Home, where each alert
              carries its own remedy. */}
          <AlertBadge count={alertCount} worst={alertWorst} onClick={onOpenAlerts} />
          {/* The kill switch sits beside Run now, on every tab: "stop spending my money" must
              never be more than one click away. */}
          <PauseControl paused={paused} onChanged={onPauseChange} />
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
        <div className="tabs" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id}
              className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => onTab(t.id)}>
              {t.label}
            </button>
          ))}
          <div className="nav-spacer" />
          <button
            className={`tab diag ${tab === 'diagnostics' ? 'active' : ''}`}
            aria-current={tab === 'diagnostics' ? 'page' : undefined}
            onClick={() => onTab('diagnostics')}
          >
            Diagnostics
          </button>
        </div>
      </div>
    </>
  )
}
