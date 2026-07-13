import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadAll, loadHealth, onboardingStatus, type ActivityRow, type DashData, type Health, type OnboardingStatus } from './api'
import { useStrategy } from './lib/useStrategy'
import { alertSummary, deriveAlerts } from './lib/alerts'
import { buildNetSeries } from './lib/pnlSeries'
import { Nav, type TabId } from './components/Nav'
import { HomeTab } from './components/HomeTab'
import { DatanetsTab } from './components/DatanetsTab'
import { DiagnosticsTab } from './components/DiagnosticsTab'
import { ChatTab } from './components/ChatTab'
import { PanelDrawer } from './components/PanelDrawer'
import { Onboarding } from './components/Onboarding'
import { PausedBanner } from './components/PauseControl'
import { useDismissed } from './components/AlertsPanel'

export function App() {
  const [data, setData] = useState<DashData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [obStatus, setObStatus] = useState<OnboardingStatus | null>(null)
  const [reconfiguring, setReconfiguring] = useState(false)
  const [tab, setTab] = useState<TabId>('home')
  const [panelRow, setPanelRow] = useState<ActivityRow | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [healthLoaded, setHealthLoaded] = useState(false)
  // Bumped by the "Raise spending caps" remedy: it must land the operator ON the caps, not
  // merely on the tab that contains them.
  const [capsSignal, setCapsSignal] = useState(0)
  // The datanet a yield-leaderboard row click is asking for. DatanetsTab scrolls to it,
  // flashes it, and CONSUMES it (→ null) — so coming back to the tab later does not
  // re-scroll to a datanet the operator has long since stopped thinking about.
  const [focusNet, setFocusNet] = useState<string | null>(null)

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
  const netNames = data?.netNames ?? {}
  const strategy = useStrategy(cfg) // hooks run unconditionally — before any early return

  // Profit OVER TIME and the alert set are derived ONCE, here, and shared: the header badge
  // and Home must never disagree about how many things are wrong.
  const series = useMemo(
    () => buildNetSeries(data?.activity ?? [], data?.pnl),
    [data?.activity, data?.pnl],
  )
  const alerts = useMemo(
    () => deriveAlerts({
      health: health?.datanets ?? [],
      config: data?.config ?? {},
      snapshot: snap,
      datanetPnl: data?.datanetPnl ?? [],
      activity: data?.activity ?? [],
      series,
      netNames,
      now: Date.now(),
    }),
    [health, data, snap, netNames, series],
  )
  // The badge counts DISMISSED alerts too — dismissing tidies the screen, it does not fix
  // the node, and the header must not pretend otherwise.
  const { count, worst } = alertSummary(alerts)
  const dismissal = useDismissed()

  // "Raise spending caps", from anywhere: go to Datanets AND open the caps.
  const openCaps = useCallback(() => {
    setTab('datanets')
    setCapsSignal((n) => n + 1)
  }, [])

  // Go to Datanets. With an id (a leaderboard row), land the operator ON that row; without
  // one ("adjust vote shares →", "N need your attention"), just open the tab.
  const goToDatanets = useCallback((datanetId?: string) => {
    setTab('datanets')
    setFocusNet(datanetId ?? null)
  }, [])

  // Pause is SERVER state (POST /api/pause writes the config itself). The candidate carries
  // it too, so a later Save cannot silently un-pause the node — syncPaused moves the
  // candidate AND the baseline, so the pause is never mistaken for an unsaved edit.
  const paused = strategy.candidate?.paused ?? cfg?.paused ?? false
  const onPauseChange = useCallback((next: boolean) => {
    strategy.syncPaused(next)
    void refresh()
  }, [strategy, refresh])

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
      <Nav data={data} asof={asof} tab={tab} onTab={setTab} paused={paused} onPauseChange={onPauseChange}
        onRefresh={() => void refresh()}
        alertCount={count} alertWorst={worst} onOpenAlerts={() => setTab('home')} />
      <main className="shell">
        {/* Impossible to miss, on every tab: a quiet dashboard must never be a mystery. */}
        <PausedBanner paused={paused} onChanged={onPauseChange} />

        {tab === 'home' && (
          <HomeTab
            data={data}
            health={health?.datanets ?? []}
            strategy={strategy}
            paused={paused}
            series={series}
            alerts={alerts}
            dismissal={dismissal}
            onOpenCaps={openCaps}
            onResume={() => onPauseChange(false)}
            onGoToDatanets={goToDatanets}
            onGoToDiagnostics={() => setTab('diagnostics')}
            onRunNow={() => void refresh()}
          />
        )}
        {tab === 'datanets' && (
          <DatanetsTab
            strategy={strategy}
            netNames={netNames}
            health={health?.datanets ?? []}
            datanetPnl={data?.datanetPnl ?? []}
            snapshot={snap}
            pnl={data?.pnl ?? null}
            activity={data?.activity ?? []}
            capsSignal={capsSignal}
            focusDatanet={focusNet}
            onFocusConsumed={() => setFocusNet(null)}
            onReconfigure={() => setReconfiguring(true)}
          />
        )}
        {/* Kept mounted (hidden when off-tab) so the conversation, draft input, and scroll
            position survive switching tabs. */}
        <div style={{ display: tab === 'assistant' ? 'block' : 'none' }}>
          <ChatTab strategy={strategy} onGoToStrategy={() => setTab('datanets')} />
        </div>
        {tab === 'diagnostics' && (
          <DiagnosticsTab
            activity={data?.activity ?? []}
            health={health}
            healthLoaded={healthLoaded}
            // The reliability headline must be the SAME derivation as Home's coverage — two
            // headline numbers for the health of one node is one too many.
            datanets={cfg?.datanets ?? {}}
            netNames={netNames}
            onOpenPanel={setPanelRow}
            onConfigChanged={() => void refresh()}
            onBack={() => setTab('home')}
          />
        )}
      </main>
      {panelRow && <PanelDrawer row={panelRow} onClose={() => setPanelRow(null)} />}
    </div>
  )
}
