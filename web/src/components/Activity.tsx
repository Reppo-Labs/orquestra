import { useState } from 'react'
import type { ActivityRow } from '../api'
import { fmt, netLabel } from '../lib/format'

const txLink = (r: ActivityRow) =>
  /^0x[0-9a-fA-F]{1,64}$/.test(r.txHash ?? '') ? (
    <a href={`https://basescan.org/tx/${r.txHash}`} target="_blank" rel="noreferrer" className="mono">{r.txHash!.slice(0, 8)}…</a>
  ) : null

const pillClass = (r: ActivityRow) =>
  r.kind === 'vote' ? (r.direction === 'up' || r.direction === 'down' ? r.direction : 'vote') : r.kind

/** What a claim actually paid, named by the token it paid in. Most datanets
 *  emit REPPO, but not all — datanet 3 (Sherwood) pays WOOD — and hardcoding
 *  the symbol reported a real 737 WOOD payout as "0 REPPO", i.e. as if the
 *  claim had earned nothing. Both legs can be present, so read the row rather
 *  than assume which one applies. */
const claimAmount = (r: ActivityRow): string => {
  const legs: string[] = []
  if (r.reppoClaimed) legs.push(`${fmt(r.reppoClaimed)} REPPO`)
  if (r.claimedTokenSymbol && r.claimedTokenAmount) {
    legs.push(`${fmt(r.claimedTokenAmount)} ${r.claimedTokenSymbol}`)
  }
  // No measurable leg. Say that without naming a token — which token this claim
  // would have paid is precisely what is unknown here.
  return legs.length > 0 ? legs.join(' + ') : 'nothing claimed'
}

const detail = (r: ActivityRow) =>
  r.kind === 'vote'
    ? (r.direction ? `${r.direction} · conv ${r.conviction} · ${r.reason ?? ''}` : (r.detail || '—'))
    // mint: score + reason (pod name is in the Pod column). Fall back to the
    // executor detail, then nothing — never the canonical-key hash.
    : r.kind === 'mint' ? (r.reason ? `score ${r.conviction ?? '?'} · ${r.reason}` : (r.detail || '—'))
    // skip + grant + stake + info are free-text breadcrumbs — grant carries "granted access — paid
    // 50 EXY"; stake carries "topped up veREPPO 1031 → 2000 (+969, 30d)"; info carries the
    // per-datanet emission-yield summary (src/voter/yield.ts formatYieldLine).
    // eval rows are evalwork breadcrumbs ("judged 3 criteria (citations)"); podId carries the jobId.
    : r.kind === 'skip' || r.kind === 'grant' || r.kind === 'stake' || r.kind === 'info' || r.kind === 'eval' ? (r.reason ?? '—')
    // claim: what it PAID when it worked, and WHY when it did not.
    //
    // This branch used to render claimAmount() unconditionally, so a failed claim showed
    // "epoch 132 · nothing claimed" — which only says no amount was recorded, and is
    // trivially true of every failure. The executor's reason was stored on the row the
    // whole time and simply never displayed. A node whose wallet had run out of gas spent
    // a week reporting 14 identical "nothing claimed" errors per cycle while the row it
    // was rendering held "claim-emissions tx failed to submit".
    : `epoch ${r.epoch} · ${r.status === 'executed' ? claimAmount(r) : (r.detail || claimAmount(r))}`

/** Pod column: prefer the human-readable name; fall back to the id for entries
 *  logged before names were recorded. */
const podLabel = (r: ActivityRow) => r.podName ?? r.podId ?? r.canonicalKey ?? ''

/** Detail cell: clamped to 2 lines — long unbroken CLI error strings otherwise widen
 *  the table past the panel's overflow:hidden and clip the Status/Tx columns. Click
 *  toggles the full text; wrap-anywhere makes JSON/URLs wrap instead of pushing layout. */
function DetailCell({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <span
      className={`detail-clamp ${open ? 'open' : ''}`}
      title={open ? 'click to collapse' : 'click to expand'}
      onClick={() => setOpen((o) => !o)}
    >{text}</span>
  )
}

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
  // Default view hides 'skip' rows: an idle datanet writes one per cycle ("rewards
  // pool dry", "none passed scoring"), which drowns the votes/mints/claims the feed
  // exists to show. They stay one dropdown click away ("skips") and still feed the
  // health tab's idleness detection, which reads the DB directly, not this filter.
  const rows = activity.filter((r) => (kind ? r.kind === kind : r.kind !== 'skip') && (!net || r.datanetId === net))
  return (
    <div>
      <div className="sec-head">
        <h2>Activity</h2><div className="rule" />
        <select value={net} onChange={(e) => setNet(e.target.value)}>
          <option value="">all datanets</option>
          {netIds.map((id) => <option key={id} value={id}>{netLabel(id, netNames)}</option>)}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">all kinds (no skips)</option>
          <option value="vote">votes</option><option value="mint">mints</option>
          <option value="claim">claims</option><option value="skip">skips</option>
          <option value="grant">grants</option><option value="stake">stakes</option>
          <option value="info">info</option>
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
                <td className="net-cell" title={r.datanetId ? netLabel(r.datanetId, netNames) : undefined}>
                  {r.datanetId ? netLabel(r.datanetId, netNames) : ''}
                </td>
                <td>{podLabel(r)}</td>
                <td className="detail-cell"><DetailCell text={detail(r)} /></td>
                <td className={r.status === 'executed' ? 'pos' : 'neg'}>{r.status}</td>
                <td>{txLink(r)}</td>
              </tr>
            )) : <tr><td colSpan={7} className="empty">no cycles yet — the node runs on your configured cadence; votes and mints appear here as each cycle completes</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
