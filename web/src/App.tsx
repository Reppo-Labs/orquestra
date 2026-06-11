import { useCallback, useEffect, useState } from 'react'
import { loadAll, type DashData } from './api'
import { fmt } from './lib/format'
import { PnlCards } from './components/PnlCards'
import { CycleHealth } from './components/CycleHealth'
import { BudgetBurn } from './components/BudgetBurn'
import { StrategyPanel } from './components/StrategyPanel'
import { Emissions } from './components/Emissions'
import { Activity } from './components/Activity'

export function App() {
  const [data, setData] = useState<DashData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setData(await loadAll())
      setError(null)
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

  return (
    <>
      <header>
        <h1>
          Orquestra{' '}
          <span className="muted">
            {cfg ? `· ${cfg.cadenceHours}h cadence · claim ${cfg.claimEmissions ? 'on' : 'off'}` : ''}
          </span>
        </h1>
        <span className="muted">
          {error ? `load error: ${error}` : snap ? `as of ${new Date(snap.ts).toLocaleString()}` : 'PnL pending first cycle'}
        </span>
      </header>
      <main>
        <div className="muted" style={{ marginBottom: 16 }}>
          {earn
            ? `Earn-test: ${earn.earning ? 'EARNING' : earn.totalUpVotes > 0 ? 'accruing upvotes (emissions lag)' : 'no signal yet'} · ${earn.mintedPods} pod(s), ${fmt(earn.claimableReppo)} claimable + ${fmt(earn.claimedReppo)} claimed REPPO, ${earn.totalUpVotes}↑/${earn.totalDownVotes}↓`
            : 'Earn-test: pending first cycle'}
        </div>
        <PnlCards pnl={data?.pnl ?? null} snapshot={snap} />
        <CycleHealth health={data?.health ?? null} netNames={data?.netNames ?? {}} />
        <BudgetBurn snapshot={snap} />
        {cfg && cfg.datanets ? <StrategyPanel config={cfg} netNames={data?.netNames ?? {}} /> : null}
        <Emissions snapshot={snap} />
        <Activity activity={data?.activity ?? []} />
      </main>
    </>
  )
}
