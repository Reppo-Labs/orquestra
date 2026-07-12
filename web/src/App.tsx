import { useCallback, useEffect, useState } from 'react'
import { loadAll, loadHealth, onboardingStatus, type ActivityRow, type DashData, type Health, type OnboardingStatus } from './api'
import { useStrategy } from './lib/useStrategy'
import { Nav, type TabId } from './components/Nav'
import { PnlCards } from './components/PnlCards'
import { EmissionsSummary } from './components/EmissionsSummary'
import { BudgetBurn } from './components/BudgetBurn'
import { DatanetEconomics } from './components/DatanetEconomics'
import { StrategyTab } from './components/StrategyTab'
import { ChatTab } from './components/ChatTab'
import { Activity } from './components/Activity'
import { HealthTab } from './components/HealthTab'
import { LearningTab } from './components/LearningTab'
import { PanelDrawer } from './components/PanelDrawer'
import { Onboarding } from './components/Onboarding'
import { FirstRunCard } from './components/FirstRunCard'
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
  const [health, setHealth] = useState<Health | null>(null)
  const [healthLoaded, setHealthLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const healthP = loadHealth() // in parallel with loadAll; never rejects (degrades to null)
    try {
      const [d, ob] = await Promise.all([loadAll(), onboardingStatus()])
      setData(d); setObStatus(ob); setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setHealth(await healthP); setHealthLoaded(true)
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
      <Nav data={data} asof={asof} tab={tab} onTab={setTab} activityCount={data?.activity.length ?? 0} onRefresh={() => void refresh()} />
      <main className="shell">
        {tab === 'overview' && (
          <div key="ov">
            <FirstRunCard
              cadenceHours={cfg?.cadenceHours}
              hasActivity={(data?.activity.length ?? 0) > 0}
              onGoToActivity={() => setTab('activity')}
              onGoToStrategy={() => setTab('strategy')}
            />
            <div className="earn-banner">
              <span className={`dot ${earn?.earning ? 'on' : earn && earn.totalUpVotes > 0 ? 'warm' : 'off'}`} />
              {earn ? (
                // Segmented metadata strip: hairline separators, not ·-chains.
                <>
                  <span className="bseg">{earn.earning ? 'EARNING' : earn.totalUpVotes > 0 ? 'accruing upvotes (emissions lag)' : 'no signal yet'}</span>
                  <span className="bseg">{earn.mintedPods} pod(s)</span>
                  <span className="bseg">{fmt(earn.claimableReppo)} claimable{(earn.claimablePairs ?? 0) > 0 ? ` (${earn.claimablePairs} pending)` : ''} + {fmt(earn.claimedReppo)} claimed</span>
                  <span className="bseg">{earn.totalUpVotes}↑/{earn.totalDownVotes}↓</span>
                </>
              ) : 'earn-test pending first cycle'}
            </div>
            <SecHead title="Emissions" />
            <EmissionsSummary pnl={data?.pnl ?? null} earn={earn} snapshot={snap} netNames={netNames} />
            <PnlCards pnl={data?.pnl ?? null} snapshot={snap} />
            <SecHead title="Budget burn" />
            <BudgetBurn snapshot={snap} />
            <DatanetEconomics snapshot={snap} netNames={netNames} onGoToStrategy={() => setTab('strategy')} />
          </div>
        )}
        {tab === 'strategy' && (
          <StrategyTab strategy={strategy} netNames={netNames} economics={snap?.datanetEconomics}
            onReconfigure={() => setReconfiguring(true)} />
        )}
        {/* Kept mounted (hidden when off-tab) so the conversation, draft input, and
            scroll position survive switching tabs. */}
        <div style={{ display: tab === 'chat' ? 'block' : 'none' }}>
          <ChatTab strategy={strategy} onGoToStrategy={() => setTab('strategy')} />
        </div>
        {tab === 'activity' && (
          <Activity activity={data?.activity ?? []} netNames={netNames} onOpenPanel={setPanelRow} />
        )}
        {tab === 'health' && (
          <HealthTab health={health} loaded={healthLoaded} netNames={netNames} />
        )}
        {tab === 'learning' && (
          <LearningTab netNames={netNames} onConfigChanged={() => void refresh()} />
        )}
      </main>
      {panelRow && <PanelDrawer row={panelRow} onClose={() => setPanelRow(null)} />}
    </div>
  )
}
