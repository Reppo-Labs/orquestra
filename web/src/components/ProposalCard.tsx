import type { LearnProposal } from '../api'

/** One pending config proposal: field, from→to, rationale, Accept / Dismiss.
 *  Accept goes through the validated config writer (applies next cycle); a proposal
 *  whose base value drifted is rejected server-side as stale. */
export function ProposalCard({ p, label, busy, onDecide }: {
  p: LearnProposal
  label: string
  busy: boolean
  onDecide: (id: number, decision: 'accept' | 'reject') => void
}) {
  return (
    <div className="panel-box" style={{ padding: '12px 14px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span className="pill mint">{p.field}</span>
        <span className="dim">{label}</span>
        <span className="mono">{p.fromValue} → <span className="pos">{p.toValue}</span></span>
        <span style={{ flex: 1 }} />
        <button className="btn primary sm" disabled={busy} onClick={() => onDecide(p.id, 'accept')}>Accept</button>
        <button className="btn ghost sm" disabled={busy} onClick={() => onDecide(p.id, 'reject')}>Dismiss</button>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>{p.rationale}</div>
    </div>
  )
}
