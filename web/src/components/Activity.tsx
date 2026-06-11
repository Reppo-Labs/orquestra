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

export function Activity({ activity }: { activity: ActivityRow[] }) {
  const [kind, setKind] = useState('')
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
          {rows.length ? rows.map((r, i) => (
            <tr key={i}>
              <td>{new Date(r.ts).toLocaleTimeString()}</td>
              <td><span className={`pill ${pillClass(r)}`}>{r.kind}</span></td>
              <td>{r.datanetId}</td>
              <td>{r.podId ?? r.canonicalKey ?? ''}</td>
              <td>{detail(r)}</td>
              <td className={r.status === 'executed' ? '' : 'err'}>{r.status}</td>
              <td>{txLink(r)}</td>
            </tr>
          )) : <tr><td colSpan={7} className="muted">no activity yet</td></tr>}
        </tbody>
      </table>
    </>
  )
}
