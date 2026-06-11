import type { Health, HealthCounts, TxRate } from '../api'
import { netLabel } from '../lib/format'

const kc = (c: HealthCounts) => `${c.executed}/${c.refused}/${c.error}`

function RateCell({ t }: { t?: TxRate }) {
  if (!t || t.rate === null) return <span className="muted">—</span>
  return (
    <>
      <span className={t.rate >= 0.9 ? 'pos' : t.rate >= 0.5 ? '' : 'neg'}>{Math.round(t.rate * 100)}%</span>{' '}
      <span className="muted">({t.executed}✓/{t.failed}✗)</span>
    </>
  )
}

export function CycleHealth({ health, netNames }: { health: Health | null; netNames: Record<string, string> }) {
  const rows = health?.datanets ?? []
  // Idle datanets: why a configured datanet is doing nothing RIGHT NOW (newest entry
  // is a skip) — a stale skip reason from before activity resumed must not show.
  const idle = rows.filter((d) => d.idle && d.lastSkipReason)
  const overall = health?.txRate
  return (
    <>
      <h2>Cycle health</h2>
      <table>
        <thead>
          <tr><th>Datanet</th><th>Votes ✓/⊘/✗</th><th>Mints ✓/⊘/✗</th><th>Tx rate</th><th>Skips</th><th>Top error</th></tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((d) => (
            <tr key={d.datanetId}>
              <td>{netLabel(d.datanetId, netNames)}</td>
              <td>{kc(d.votes)}</td>
              <td>{kc(d.mints)}</td>
              <td><RateCell t={d.txRate} /></td>
              <td>{d.skips || ''}</td>
              <td className="err">{d.topErrors[0] ? `${d.topErrors[0].code} × ${d.topErrors[0].count}` : ''}</td>
            </tr>
          )) : <tr><td colSpan={6} className="muted">no activity yet</td></tr>}
        </tbody>
      </table>
      <div className="muted" style={{ margin: '-16px 0 16px 0' }}>
        {overall && overall.rate !== null ? <>overall tx success: <RateCell t={overall} /> over the 7-day window</> : null}
      </div>
      <div style={{ marginBottom: 24 }}>
        {idle.map((d) => (
          <div className="skipreason" key={d.datanetId}>datanet {d.datanetId} idle — {d.lastSkipReason}</div>
        ))}
      </div>
    </>
  )
}
