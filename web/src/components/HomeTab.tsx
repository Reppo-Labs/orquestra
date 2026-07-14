import { useState } from 'react'
import { runNow, type DashData, type HealthDatanet } from '../api'
import type { Strategy } from '../lib/useStrategy'
import type { Alert } from '../lib/alerts'
import type { NetSeries } from '../lib/pnlSeries'
import { fmtCount, fmtPct, fmtReppo, netLabel } from '../lib/format'
import {
  coverage, emissionsStarted, losingDatanets, nextAction, pendingByDatanet, recoveredDatanets,
} from '../lib/datanetStatus'
import { AlertsPanel } from './AlertsPanel'
import { BudgetBurn } from './BudgetBurn'
import { DatanetEconomics } from './DatanetEconomics'
import { EarnBanner } from './EarnBanner'
import { EmissionsSummary } from './EmissionsSummary'
import { FirstRunCard } from './FirstRunCard'
import { NetChart } from './NetChart'
import { PnlCards } from './PnlCards'

// Home answers exactly two questions: am I making money, and what do I do about it.
// Everything that answers neither — claimed all-time, claimable, gas, LLM cost, REPPO
// balance, veREPPO, epoch — is still one click away, but it is no longer the first thing a
// non-technical operator sees. A wall of eight numbers is not an answer.

export function HomeTab({
  data, health, strategy, paused, series, alerts, dismissal, onOpenCaps,
  onResume, onGoToDatanets, onGoToDiagnostics, onRunNow,
}: {
  data: DashData | null
  health: HealthDatanet[]
  strategy: Strategy
  paused: boolean
  /** Net REPPO over time — the second-most-important fact after the verdict itself. */
  series: NetSeries | null
  /** Derived in App so the header badge and this list can never disagree. */
  alerts: Alert[]
  dismissal: { dismissed: Set<string>; dismiss: (id: string) => void; restore: () => void }
  onOpenCaps: () => void
  /** Resume, straight from the one-next-action card. */
  onResume: () => void
  /** Go to the Datanets tab. With a datanetId (a yield-leaderboard row click), land ON that
   *  datanet's row — scrolled to and briefly highlighted — instead of at the top of a list
   *  where the operator has to hunt for the row they just clicked. */
  onGoToDatanets: (datanetId?: string) => void
  onGoToDiagnostics: () => void
  onRunNow: () => void
}) {
  const [details, setDetails] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')

  const cfg = data?.config
  const netNames = data?.netNames ?? {}
  const activity = data?.activity ?? []
  // A classification is only current if the datanet has not worked SINCE it (see
  // recoveredDatanets) — otherwise a transient error six days ago keeps a healthy datanet
  // out of the working count for a week.
  const recovered = recoveredDatanets(activity)
  const cov = coverage(cfg?.datanets ?? {}, health, recovered)

  // Emissions lag votes and mints by roughly an epoch, and a datanet's `reppoEarned` counts
  // only CLAIMED rows. Judging "losing money" on that alone calls every minting datanet a
  // loss-maker from its first mint until its first claim lands — the exact opposite of the
  // "too early to tell" banner directly above. So: credit the emissions this datanet is
  // already owed, and give no verdict at all until the node has been paid something,
  // somewhere.
  const pending = pendingByDatanet(data?.snapshot)
  const started = emissionsStarted(data?.pnl)
  const losing = losingDatanets(data?.datanetPnl ?? [], { pending, started })
  const hasRun = activity.length > 0

  // A datanet's P&L is LIFETIME, so a loss survives the datanet being turned off or dropped
  // from the config. The loss is still worth showing — it is how the operator got here — but
  // "Stop minting" must only be offered where minting is actually still ON. A button that
  // says it acts and silently does nothing is the same lie this whole redesign is fixing.
  const stillMinting = (id: string): boolean => cfg?.datanets?.[id]?.mint === true
  const action = nextAction({
    paused,
    losing: losing.filter((p) => stillMinting(p.datanetId)),
    cov,
    hasRun,
    // The next-action card MUST see the alerts, or it reassures the operator ("Nothing needs
    // your attention — you do not need to be here") with a critical alert live on the same
    // screen. Dismissed alerts still count: dismissing tidies the screen, it does not fix
    // the node.
    alerts: { total: alerts.length, critical: alerts.filter((a) => a.severity === 'critical').length },
  })

  // "Stop minting there" — the entire point of surfacing a losing datanet. Persists
  // immediately: a remedy the operator must remember to save is not a remedy. The RESULT is
  // reported: a save that 400s, or a node that cannot be reached, must never print "applied".
  const stopMinting = async (id: string) => {
    setBusy(true)
    setDone('')
    try {
      const res = await strategy.editAndSave((c) => { if (c.datanets[id]) c.datanets[id].mint = false })
      // Only an explicit { ok:false } is a failure — editAndSave resolves undefined in test
      // fakes and must not read as one; a real save failure always carries ok:false.
      setDone(res?.ok !== false
        ? `Datanet ${id}: minting off — applies next cycle.`
        : `Could not stop minting on datanet ${id}: ${res.error ?? 'the node refused the change'}. Nothing was changed.`)
    } finally {
      setBusy(false) // even on an unexpected throw: a button stuck on "working…" is a dead end
    }
  }

  const runAction = async () => {
    switch (action.kind) {
      case 'resume': onResume(); return
      case 'stop_minting': if (action.datanetId) await stopMinting(action.datanetId); return
      case 'fix_blocked': onGoToDatanets(); return
      // The label promises the CAPS. onGoToDatanets drops the operator at the top of a long
      // list with the caps collapsed inside a disclosure they were never told about;
      // onOpenCaps opens it and puts them on the heading — the same remedy from the alert
      // card one section above already did this.
      case 'raise_budget': onOpenCaps(); return
      case 'wait': {
        // Off-schedule cycle. The scheduler enforces no-overlap, so a click during a cycle
        // is a harmless no-op (the node replies started:false + a reason).
        setBusy(true)
        const r = await runNow()
        setBusy(false)
        setDone(r.started ? 'Cycle started — results appear as they land.' : (r.reason ?? r.error ?? 'could not start'))
        onRunNow()
        return
      }
      default:
    }
  }

  return (
    <div key="home">
      <FirstRunCard
        cadenceHours={cfg?.cadenceHours}
        hasActivity={hasRun}
        onGoToActivity={onGoToDiagnostics}
        onGoToStrategy={onGoToDatanets}
      />

      {/* Profit/loss first. `earn.earning` only means "emissions detected" and must never be
          shown to an operator as "you are making money". */}
      <EarnBanner pnl={data?.pnl ?? null} earn={data?.earn} />

      {/* Then the TREND. A point-in-time net cannot tell an operator whether to act: the same
          "Losing 1,906 REPPO" is patience if it is recovering and a decision if it is not. */}
      <NetChart series={series} />

      {/* Then what is broken. The node can be dead for days; this is where it says so. */}
      <AlertsPanel
        alerts={alerts}
        strategy={strategy}
        snapshot={data?.snapshot ?? null}
        dismissed={dismissal.dismissed}
        onDismiss={dismissal.dismiss}
        onRestore={dismissal.restore}
        onOpenCaps={onOpenCaps}
        onGoTo={(t) => (t === 'datanets' ? onGoToDatanets() : onGoToDiagnostics())}
      />

      {/* What the node is actually doing — COVERAGE, not tx success. An idle datanet attempts
          no transactions, so it can never fail one; "100% success" over a mostly-dead node is
          the lie this replaces. */}
      <div className="home-coverage" role="status" aria-label="Datanet coverage">
        <span className="cov-num">{fmtCount(cov.working)} of {fmtCount(cov.total)}</span>
        <span className="cov-txt"> datanet{cov.total === 1 ? '' : 's'} working</span>
        {/* Datanets the operator switched OFF are not a hole in the node's coverage. They are
            reported, never counted against it — otherwise the number can never reach N of N
            and taking this dashboard's own advice makes the node look worse. */}
        {cov.off > 0 && <span className="cov-off muted"> · {fmtCount(cov.off)} switched off</span>}
        {/* onGoToDatanets is wrapped, never passed bare: it takes a datanetId now, and a bare
            handler would hand it the click event as one. */}
        {cov.blocked > 0 && (
          <button className="cov-warn" onClick={() => onGoToDatanets()}>
            {fmtCount(cov.blocked)} need{cov.blocked === 1 ? 's' : ''} your attention →
          </button>
        )}
      </div>

      {/* THE next action. One. */}
      <div className={`next-action ${action.kind}`}>
        <div className="na-body">
          <div className="na-head">{action.headline}</div>
          <div className="na-detail muted">{action.detail}</div>
          {done && <div className="na-done muted" role="status">{done}</div>}
        </div>
        {action.cta && (
          <button className="btn primary" disabled={busy} onClick={() => void runAction()}>
            {busy ? 'working…' : action.cta}
          </button>
        )}
      </div>

      {/* The single most actionable fact in the product: which datanets cost more than they
          return. It was nowhere in the old UI. */}
      {losing.length > 0 && (
        <>
          <div className="sec-head"><h2>Losing money</h2><div className="rule" /></div>
          <div className="panel-box">
            <table>
              <thead>
                <tr><th>Datanet</th><th>Net</th><th>Return</th><th>Spent minting</th><th>Earned</th><th /></tr>
              </thead>
              <tbody>
                {losing.map((p) => (
                  <tr key={p.datanetId}>
                    <td className="net-cell" title={netLabel(p.datanetId, netNames)}>{netLabel(p.datanetId, netNames)}</td>
                    <td className="mono neg">
                      {fmtReppo(p.net)}
                      {/* Money the datanet is OWED but has not been paid. It is credited in the
                          judgement (this row is here despite it) and shown, never folded into
                          the realized net. */}
                      {(pending[p.datanetId] ?? 0) > 0 && (
                        <span className="faint"> +{fmtReppo(pending[p.datanetId])} due</span>
                      )}
                    </td>
                    {/* roi null = nothing spent (impossible here — losing requires spend), but a
                        null must never render as a fake 0%. */}
                    <td className="mono">{p.roi === null ? '—' : fmtPct(p.roi / 100)}</td>
                    <td className="mono">{fmtReppo(p.reppoSpent)} <span className="faint">/ {fmtCount(p.mintsExecuted)} mints</span></td>
                    <td className="mono">{fmtReppo(p.reppoEarned)}</td>
                    <td>
                      {stillMinting(p.datanetId) ? (
                        <button className="btn ghost sm" disabled={busy} onClick={() => void stopMinting(p.datanetId)}>
                          Stop minting
                        </button>
                      ) : (
                        // Already off (or dropped from the strategy) — the loss is history, not a leak.
                        <span className="faint" style={{ fontSize: 12 }}>minting already off</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Stopping mints does not stop voting — voting costs no REPPO in fees and still earns emissions.
            Emissions the node is already owed are credited before a datanet is called a loss-maker.
          </div>
        </>
      )}

      {/* Everything that does not change a decision. Reachable, not in the way. */}
      <div className="details-block">
        <button className="disclosure" aria-expanded={details} aria-controls="home-details" onClick={() => setDetails((d) => !d)}>
          <span className="disclosure-caret" aria-hidden="true">{details ? '−' : '+'}</span>
          Node details
          <span className="muted"> — balances, emissions, spend, LLM cost, activity log, learning</span>
        </button>
        {details && (
          <div id="home-details">
            <div className="sec-head"><h2>Emissions</h2><div className="rule" /></div>
            <EmissionsSummary pnl={data?.pnl ?? null} earn={data?.earn} snapshot={data?.snapshot} netNames={netNames} />
            <PnlCards pnl={data?.pnl ?? null} snapshot={data?.snapshot ?? null} />
            <div className="sec-head"><h2>Budget burn</h2><div className="rule" /></div>
            <BudgetBurn snapshot={data?.snapshot ?? null} />
            <DatanetEconomics snapshot={data?.snapshot ?? null} netNames={netNames} onGoToStrategy={onGoToDatanets} />
            <div className="sec-head"><h2>Diagnostics</h2><div className="rule" /></div>
            <div className="panel-box" style={{ padding: 14 }}>
              <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                Every vote, mint, claim and skip the node has made, its 7-day reliability, and what it
                has learned from its own outcomes.
              </div>
              <button className="btn ghost sm" onClick={onGoToDiagnostics}>Open diagnostics →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
