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
    : r.kind === 'skip' ? (r.reason ?? '—')
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
  const rows = activity.filter((r) => !kind || r.kind === kind)
  return (
    <div>
      <div className="sec-head">
        <h2>Activity</h2><div className="rule" />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">all kinds</option>
          <option value="vote">votes</option><option value="mint">mints</option>
          <option value="claim">claims</option><option value="skip">skips</option>
        </select>
      </div>
      <div className="panel-box">
        <table>
          <thead><tr><th>Time</th><th>Kind</th><th>Datanet</th><th>Pod</th><th>Detail</th><th>Status</th><th>Tx</th></tr></thead>
          <tbody>
            {rows.length ? rows.map((r, i) => (
              <tr key={i}>
                <td className="mono faint">{new Date(r.ts).toLocaleTimeString()}</td>
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
