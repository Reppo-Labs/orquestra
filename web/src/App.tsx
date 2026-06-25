import { useCallback, useEffect, useState } from 'react'
import { loadAll, onboardingStatus, type ActivityRow, type DashData, type OnboardingStatus } from './api'
import { useStrategy } from './lib/useStrategy'
import { Nav, type TabId } from './components/Nav'
import { PnlCards } from './components/PnlCards'
import { EmissionsSummary } from './components/EmissionsSummary'
import { BudgetBurn } from './components/BudgetBurn'
import { StrategyTab } from './components/StrategyTab'
import { ChatTab } from './components/ChatTab'
import { Activity } from './components/Activity'
import { LearningTab } from './components/LearningTab'
import { PanelDrawer } from './components/PanelDrawer'
import { Onboarding } from './components/Onboarding'
import { fmt } from './lib/format'

function SecHead({ title }: { title: string }) {
  return <div className="sec-head"><h2>{title}</h2><div className="rule" /></div>
}

export function App() {
  const [data, setData] = useState<DashData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [obStatus, setObStatus] = useState<OnboardingStatus | null>(null)
  const [reconfiguring, setReconfiguring] = useState(false)
  const [tab, setTab] = useState<TabId>('overview')
  const [panelRow, setPanelRow] = useState<ActivityRow | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [d, ob] = await Promise.all([loadAll(), onboardingStatus()])
      setData(d); setObStatus(ob); setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(t)
  }, [refresh])

  const cfg = data?.config
  const snap = data?.snapshot ?? null
  const earn = data?.earn
  const netNames = data?.netNames ?? {}
  const strategy = useStrategy(cfg) // hooks run unconditionally — before any early return

  // Fresh node (or reconfigure): the dashboard IS the onboarding until a config exists.
  if (obStatus && (obStatus.needed || reconfiguring)) {
    return (
      <Onboarding
        status={obStatus}
        netNames={netNames}
        onDone={() => { setReconfiguring(false); void refresh() }}
        onCancel={obStatus.needed ? undefined : () => setReconfiguring(false)}
      />
    )
  }

  const asof = error ? `load error: ${error}` : snap ? `synced ${new Date(snap.ts).toLocaleTimeString()}` : 'awaiting first cycle'

  return (
    <div className="app">
      <Nav data={data} asof={asof} tab={tab} onTab={setTab} activityCount={data?.activity.length ?? 0} />
      <main className="shell">
        {tab === 'overview' && (
          <div key="ov">
            <div className="earn-banner">
              <span className={`dot ${earn?.earning ? 'on' : earn && earn.totalUpVotes > 0 ? 'warm' : 'off'}`} />
              {earn
                ? `${earn.earning ? 'EARNING' : earn.totalUpVotes > 0 ? 'accruing upvotes (emissions lag)' : 'no signal yet'} · ${earn.mintedPods} pod(s) · ${fmt(earn.claimableReppo)} claimable + ${fmt(earn.claimedReppo)} claimed · ${earn.totalUpVotes}↑/${earn.totalDownVotes}↓`
                : 'earn-test pending first cycle'}
            </div>
            <SecHead title="Emissions" />
            <EmissionsSummary pnl={data?.pnl ?? null} earn={earn} />
            <PnlCards pnl={data?.pnl ?? null} snapshot={snap} />
            <SecHead title="Budget burn" />
            <BudgetBurn snapshot={snap} />
          </div>
        )}
        {tab === 'strategy' && (
          <StrategyTab strategy={strategy} netNames={netNames} onReconfigure={() => setReconfiguring(true)} />
        )}
        {/* Kept mounted (hidden when off-tab) so the conversation, draft input, and
            scroll position survive switching tabs. */}
        <div style={{ display: tab === 'chat' ? 'block' : 'none' }}>
          <ChatTab strategy={strategy} onGoToStrategy={() => setTab('strategy')} />
        </div>
        {tab === 'activity' && (
          <Activity activity={data?.activity ?? []} netNames={netNames} onOpenPanel={setPanelRow} />
        )}
        {tab === 'learning' && (
          <LearningTab netNames={netNames} onConfigChanged={() => void refresh()} />
        )}
      </main>
      {panelRow && <PanelDrawer row={panelRow} onClose={() => setPanelRow(null)} />}
    </div>
  )
}
