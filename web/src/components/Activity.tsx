import { useState } from 'react'
import type { ActivityRow } from '../api'
import { fmt, netLabel } from '../lib/format'

const txLink = (r: ActivityRow) =>
  /^0x[0-9a-fA-F]{1,64}$/.test(r.txHash ?? '') ? (
    <a href={`https://basescan.org/tx/${r.txHash}`} target="_blank" rel="noreferrer" className="mono">{r.txHash!.slice(0, 8)}…</a>
  ) : null

const pillClass = (r: ActivityRow) =>
  r.kind === 'vote' ? (r.direction === 'up' || r.direction === 'down' ? r.direction : 'vote') : r.kind

const detail = (r: ActivityRow) =>
  r.kind === 'vote'
    ? (r.direction ? `${r.direction} · conv ${r.conviction} · ${r.reason ?? ''}` : (r.detail || '—'))
    // mint: score + reason (pod name is in the Pod column). Fall back to the
    // executor detail, then nothing — never the canonical-key hash.
    : r.kind === 'mint' ? (r.reason ? `score ${r.conviction ?? '?'} · ${r.reason}` : (r.detail || '—'))
    // skip + grant + stake are free-text breadcrumbs — grant carries "granted access — paid
    // 50 EXY"; stake carries "topped up veREPPO 1031 → 2000 (+969, 30d)".
    : r.kind === 'skip' || r.kind === 'grant' || r.kind === 'stake' ? (r.reason ?? '—')
    : `epoch ${r.epoch} · ${fmt(r.reppoClaimed)} REPPO`

/** Pod column: prefer the human-readable name; fall back to the id for entries
 *  logged before names were recorded. */
const podLabel = (r: ActivityRow) => r.podName ?? r.podId ?? r.canonicalKey ?? ''

export function Activity({ activity, netNames, onOpenPanel }: {
  activity: ActivityRow[]
  netNames: Record<string, string>
  onOpenPanel: (r: ActivityRow) => void
}) {
  const [kind, setKind] = useState('')
  const [net, setNet] = useState('')
  // Datanets to offer in the filter: those that actually appear in the activity,
  // sorted numerically. Derived from the rows so the dropdown never lists a datanet
  // with nothing to show.
  const netIds = [...new Set(activity.map((r) => r.datanetId).filter((id): id is string => !!id))]
    .sort((a, b) => Number(a) - Number(b))
  const rows = activity.filter((r) => (!kind || r.kind === kind) && (!net || r.datanetId === net))
  return (
    <div>
      <div className="sec-head">
        <h2>Activity</h2><div className="rule" />
        <select value={net} onChange={(e) => setNet(e.target.value)}>
          <option value="">all datanets</option>
          {netIds.map((id) => <option key={id} value={id}>{netLabel(id, netNames)}</option>)}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">all kinds</option>
          <option value="vote">votes</option><option value="mint">mints</option>
          <option value="claim">claims</option><option value="skip">skips</option>
          <option value="grant">grants</option><option value="stake">stakes</option>
        </select>
      </div>
      <div className="panel-box">
        <table>
          <thead><tr><th>Time</th><th>Kind</th><th>Datanet</th><th>Pod</th><th>Detail</th><th>Status</th><th>Tx</th></tr></thead>
          <tbody>
            {rows.length ? rows.map((r, i) => (
              <tr key={i}>
                <td className="mono faint" style={{ whiteSpace: 'nowrap' }}>
                  <div>{new Date(r.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
                  <div>{new Date(r.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
                </td>
                <td>
                  <span className={`pill ${pillClass(r)}`}>{r.kind}</span>
                  {r.panel && (
                    <button className="panel-badge" onClick={() => onOpenPanel(r)} title="multi-agent panel decided this">
                      ⚖ {r.panel.panelists.length}
                    </button>
                  )}
                </td>
                <td>{r.datanetId ? netLabel(r.datanetId, netNames) : ''}</td>
                <td>{podLabel(r)}</td>
                <td>{detail(r)}</td>
                <td className={r.status === 'executed' ? 'pos' : 'neg'}>{r.status}</td>
                <td>{txLink(r)}</td>
              </tr>
            )) : <tr><td colSpan={7} className="empty">no activity yet</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
