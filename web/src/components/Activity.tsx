import { useState } from 'react'
import type { ActivityRow } from '../api'
import { fmt } from '../lib/format'

// txHash is allowlisted by SHAPE before being used in a URL (escaping isn't
// enough for href context); React escapes all text interpolation by default.
const txLink = (r: ActivityRow) =>
  /^0x[0-9a-fA-F]{1,64}$/.test(r.txHash ?? '') ? (
    <a href={`https://basescan.org/tx/${r.txHash}`} target="_blank" rel="noreferrer">{r.txHash!.slice(0, 8)}…</a>
  ) : null

const pillClass = (r: ActivityRow) =>
  r.kind === 'vote' ? (r.direction === 'up' || r.direction === 'down' ? r.direction : 'vote') : r.kind

const detail = (r: ActivityRow) =>
  r.kind === 'vote'
    ? (r.direction ? `${r.direction} · conv ${r.conviction} · ${r.reason ?? ''}` : (r.detail || '—'))
    : r.kind === 'mint' ? (r.podName ?? r.canonicalKey ?? '')
    : r.kind === 'skip' ? (r.reason ?? '—')
    : `epoch ${r.epoch} · ${fmt(r.reppoClaimed)} REPPO`

function PanelDetail({ panel }: { panel: NonNullable<ActivityRow['panel']> }) {
  return (
    <div className="panel-transcript">
      {panel.screenScore !== undefined && <div className="muted">screen score: {panel.screenScore} → panel convened</div>}
      {panel.panelists.map((p) => (
        <div key={p.persona}><span className="panel-persona">{p.persona} ({p.score})</span> {p.argument}</div>
      ))}
      <div className="panel-judge">judge → {panel.judge.score}: {panel.judge.reason}</div>
    </div>
  )
}

export function Activity({ activity }: { activity: ActivityRow[] }) {
  const [kind, setKind] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const rows = activity.filter((r) => !kind || r.kind === kind)
  return (
    <>
      <h2>
        Activity{' '}
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">all</option>
          <option>vote</option><option>mint</option><option>claim</option><option>skip</option>
        </select>
      </h2>
      <table>
        <thead><tr><th>Time</th><th>Kind</th><th>Datanet</th><th>Pod</th><th>Detail</th><th>Status</th><th>Tx</th></tr></thead>
        <tbody>
          {rows.length ? rows.flatMap((r, i) => {
            const main = (
              <tr key={i}>
                <td>{new Date(r.ts).toLocaleTimeString()}</td>
                <td>
                  <span className={`pill ${pillClass(r)}`}>{r.kind}</span>
                  {r.panel && (
                    <button className="panel-badge" title="multi-agent panel decided this — click to expand"
                      onClick={() => setOpen(open === i ? null : i)}>⚖ {r.panel.panelists.length}-agent</button>
                  )}
                </td>
                <td>{r.datanetId}</td>
                <td>{r.podId ?? r.canonicalKey ?? ''}</td>
                <td>{detail(r)}</td>
                <td className={r.status === 'executed' ? '' : 'err'}>{r.status}</td>
                <td>{txLink(r)}</td>
              </tr>
            )
            return r.panel && open === i
              ? [main, <tr key={`${i}-panel`}><td colSpan={7}><PanelDetail panel={r.panel} /></td></tr>]
              : [main]
          }) : <tr><td colSpan={7} className="muted">no activity yet</td></tr>}
        </tbody>
      </table>
    </>
  )
}
