import type { Health, HealthCounts, TxRate } from '../api'
import { netLabel } from '../lib/format'

const kc = (c: HealthCounts) => `${c.executed}/${c.refused}/${c.error}`

function RateCell({ t }: { t?: TxRate }) {
  if (!t || t.rate === null) return <span className="faint">—</span>
  return (
    <>
      <span className={t.rate >= 0.9 ? 'pos' : t.rate >= 0.5 ? '' : 'neg'}>{Math.round(t.rate * 100)}%</span>{' '}
      <span className="faint">({t.executed}✓/{t.failed}✗)</span>
    </>
  )
}

export function CycleHealth({ health, netNames }: { health: Health | null; netNames: Record<string, string> }) {
  const rows = health?.datanets ?? []
  const idle = rows.filter((d) => d.idle && d.lastSkipReason)
  const overall = health?.txRate
  return (
    <>
      <div className="panel-box">
        <table>
          <thead>
            <tr><th>Datanet</th><th>Votes ✓/⊘/✗</th><th>Mints ✓/⊘/✗</th><th>Tx rate</th><th>Skips</th><th>Top error</th></tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((d) => (
              <tr key={d.datanetId}>
                <td>{netLabel(d.datanetId, netNames)}</td>
                <td className="mono">{kc(d.votes)}</td>
                <td className="mono">{kc(d.mints)}</td>
                <td><RateCell t={d.txRate} /></td>
                <td className="mono">{d.skips || ''}</td>
                <td className="neg mono">{d.topErrors[0] ? `${d.topErrors[0].code} × ${d.topErrors[0].count}` : ''}</td>
              </tr>
            )) : <tr><td colSpan={6} className="empty">no activity yet</td></tr>}
          </tbody>
        </table>
      </div>
      {overall && overall.rate !== null && (
        <div className="faint mono" style={{ fontSize: 12, marginTop: 10 }}>overall tx success <RateCell t={overall} /> · 7-day window</div>
      )}
      {idle.map((d) => (
        <div className="skipreason" key={d.datanetId}>datanet {d.datanetId} idle — {d.lastSkipReason}</div>
      ))}
    </>
  )
}
