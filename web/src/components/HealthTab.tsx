import type { ActivityRow, DatanetEntry, Health, HealthCounts, HealthDatanet, TxRate } from '../api'
import { coverage, recoveredDatanets } from '../lib/datanetStatus'
import { fmtCount, fmtPct, netLabel } from '../lib/format'

/** Operational state is NOT profit: green/red are reserved for money (see EarnBanner),
 *  so counts here use neutral text for what worked and amber for what needs attention. */
const ATTENTION = { color: 'var(--warn)' }

/** Outcome counts for one kind (votes/mints/claims): "3 ok · 1 refused · 2 err".
 *  Refusals are budget-cap refusals (the ledger said no before signing) — visible,
 *  but never counted as tx failures. */
function Counts({ c }: { c?: HealthCounts }) {
  if (!c || c.executed + c.refused + c.error === 0) return <span className="faint">—</span>
  return (
    <span className="mono">
      <span className={c.executed > 0 ? '' : 'faint'}>{fmtCount(c.executed)} ok</span>
      {c.refused > 0 && <span className="faint"> · {fmtCount(c.refused)} refused</span>}
      {c.error > 0 && <span style={ATTENTION}> · {fmtCount(c.error)} err</span>}
    </span>
  )
}

/** On-chain success rate, scoped to ATTEMPTED transactions (budget refusals excluded).
 *  A datanet that never attempts a tx cannot fail one, so a high rate here says nothing
 *  about whether the datanet is doing any work — coverage above answers that. */
function Rate({ t }: { t?: TxRate }) {
  if (!t || t.rate === null) return <span className="faint">no tx attempted</span>
  return (
    <span className="mono">
      <span style={t.rate < 0.9 ? ATTENTION : undefined}>{fmtPct(t.rate)}</span>
      <span className="faint"> of {fmtCount(t.executed + t.failed)} attempted</span>
      {t.failed > 0 && <span style={ATTENTION}> · {fmtCount(t.failed)} failed</span>}
    </span>
  )
}

function TopErrors({ errs }: { errs: HealthDatanet['topErrors'] }) {
  if (!errs.length) return <span className="faint">none</span>
  const shown = errs.slice(0, 3)
  return (
    <span className="mono" style={{ fontSize: 12 }}>
      {shown.map((e) => `${e.code} ×${e.count}`).join(', ')}
      {errs.length > shown.length && <span className="faint"> +{errs.length - shown.length} more</span>}
    </span>
  )
}

/** 7-day reliability panel over /api/health: per-datanet vote/mint/claim outcomes,
 *  on-chain tx success rate, top reppo CLI error codes, and idle state (a datanet
 *  whose newest entry is a skip is idle right now — the reason says why). */
export function HealthTab({ health, loaded, datanets, activity = [], netNames }: {
  health: Health | null
  /** true once the first /api/health poll has completed (success or degrade). */
  loaded: boolean
  /** The CONFIGURED datanets. The headline used to be `active vs total` over whatever
   *  appeared in the 7-day health payload, which is a different question — and a different
   *  number — from Home's "N of M datanets working". One node, two headline fractions, no way
   *  to reconcile them. Both now come from coverage() whenever the config is known; without
   *  it (no strategy yet, or a caller that has none) the headline falls back to the health
   *  payload's own active/idle split rather than lying with a 0-of-0. */
  datanets?: Record<string, DatanetEntry>
  activity?: ActivityRow[]
  netNames: Record<string, string>
}) {
  const head = (
    <div className="sec-head"><h2>Health · last 7 days</h2><div className="rule" /></div>
  )
  if (!loaded) return <div key="health">{head}<div className="empty">loading…</div></div>
  if (!health) {
    return (
      <div key="health">
        {head}
        <div className="empty">could not load health — the node may be restarting. It refreshes automatically.</div>
      </div>
    )
  }
  if (!health.datanets.length) {
    return (
      <div key="health">
        {head}
        <div className="empty">no activity in the last 7 days — reliability appears once the node has run a few cycles</div>
      </div>
    )
  }
  const overall = health.txRate
  // COVERAGE is the honest node-wide headline. Tx success can read 100% while most of
  // the node does nothing: an idle datanet never attempts a transaction, so it can
  // never fail one. Lead with how much of the node is actually working — the SAME number,
  // from the same function, that Home leads with.
  const configured = datanets !== undefined && Object.keys(datanets).some((k) => k !== '*')
  const cov = configured ? coverage(datanets!, health.datanets, recoveredDatanets(activity)) : null
  const idle = health.datanets.filter((d) => d.idle).length
  const active = health.datanets.length - idle
  return (
    <div key="health">
      {head}
      <div className="health-headline" role="status" aria-label="Datanet coverage">
        <span className="health-cover">
          {cov
            ? <>{fmtCount(cov.working)} of {fmtCount(cov.total)} datanet{cov.total === 1 ? '' : 's'} working</>
            : <>{fmtCount(active)} of {fmtCount(health.datanets.length)} datanet{health.datanets.length === 1 ? '' : 's'} active</>}
        </span>
        {cov && cov.off > 0 && <span className="health-idle"> · {fmtCount(cov.off)} switched off</span>}
        {cov && cov.blocked > 0 && <span className="health-idle"> · {fmtCount(cov.blocked)} need you</span>}
        {!cov && idle > 0 && <span className="health-idle"> · {fmtCount(idle)} idle</span>}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        {idle > 0 && <>An idle datanet is doing no work right now — its reason is in the Status column. </>}
        Of the transactions actually attempted node-wide:{' '}
        {overall && overall.rate !== null
          ? <>{fmtPct(overall.rate)} succeeded ({fmtCount(overall.executed)} executed, {fmtCount(overall.failed)} failed)</>
          : <span className="faint">none attempted yet</span>}
        . Idle datanets attempt none, so they cannot fail one — this rate says nothing about coverage.
        Budget refusals are not failures either: no transaction was attempted.
      </div>
      <div className="panel-box">
        <table>
          <thead>
            <tr>
              <th>Datanet</th><th>Votes</th><th>Mints</th><th>Claims</th>
              <th title="share of ATTEMPTED transactions that succeeded">Tx success (of attempted)</th>
              <th>Top errors</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {health.datanets.map((d) => (
              <tr key={d.datanetId}>
                <td className="net-cell" title={netLabel(d.datanetId, netNames)}>{netLabel(d.datanetId, netNames)}</td>
                <td><Counts c={d.votes} /></td>
                <td><Counts c={d.mints} /></td>
                <td><Counts c={d.claims} /></td>
                <td><Rate t={d.txRate} /></td>
                <td><TopErrors errs={d.topErrors} /></td>
                <td>
                  {/* Operational state — deliberately NOT green: green means profit. */}
                  {d.idle
                    ? <span className="pill idle" title={d.lastSkipReason}>idle</span>
                    : <span className="pill active">active</span>}
                  {d.idle && d.lastSkipReason && (
                    <div className="skipreason" title={d.lastSkipReason} style={{ maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {d.lastSkipReason}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
