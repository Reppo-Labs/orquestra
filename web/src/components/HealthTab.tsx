import type { Health, HealthCounts, HealthDatanet, TxRate } from '../api'
import { netLabel } from '../lib/format'

/** Outcome counts for one kind (votes/mints/claims): "3 ok · 1 refused · 2 err".
 *  Refusals are budget-cap refusals (the ledger said no before signing) — visible,
 *  but never counted as tx failures. */
function Counts({ c }: { c?: HealthCounts }) {
  if (!c || c.executed + c.refused + c.error === 0) return <span className="faint">—</span>
  return (
    <span className="mono">
      <span className={c.executed > 0 ? 'pos' : 'faint'}>{c.executed} ok</span>
      {c.refused > 0 && <span style={{ color: 'var(--warn)' }}> · {c.refused} refused</span>}
      {c.error > 0 && <span className="neg"> · {c.error} err</span>}
    </span>
  )
}

/** On-chain success rate (executed vs failed tx attempts; budget refusals excluded). */
function Rate({ t }: { t?: TxRate }) {
  if (!t || t.rate === null) return <span className="faint">no tx yet</span>
  const p = Math.round(t.rate * 100)
  const cls = t.rate >= 0.9 ? 'pos' : t.rate < 0.5 ? 'neg' : ''
  return (
    <span className="mono">
      <span className={cls}>{p}%</span>
      {t.failed > 0 && <span className="faint"> · {t.failed} failed</span>}
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
export function HealthTab({ health, loaded, netNames }: {
  health: Health | null
  /** true once the first /api/health poll has completed (success or degrade). */
  loaded: boolean
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
  return (
    <div key="health">
      {head}
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        Node-wide tx success:{' '}
        {overall && overall.rate !== null
          ? <><Rate t={overall} /> ({overall.executed} executed / {overall.failed} failed)</>
          : <span className="faint">no on-chain attempts yet</span>}
        . Budget refusals are not failures — no tx was attempted.
      </div>
      <div className="panel-box">
        <table>
          <thead>
            <tr>
              <th>Datanet</th><th>Votes</th><th>Mints</th><th>Claims</th>
              <th>Tx success</th><th>Top errors</th><th>Status</th>
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
                  {d.idle
                    ? <span className="pill skip" title={d.lastSkipReason}>idle</span>
                    : <span className="pill up">active</span>}
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
