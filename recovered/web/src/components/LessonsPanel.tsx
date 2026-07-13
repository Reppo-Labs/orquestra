import type { LearnDatanetView } from '../api'
import { fmt, fmtPerVote } from '../lib/format'

/** Per-datanet learned-lessons panel: calibration stats line, the active lessons, and
 *  the operator controls — enable/disable learning and clear (veto) the lessons. */
export function LessonsPanel({ id, label, view, busy, onToggle, onVeto }: {
  id: string
  label: string
  view: LearnDatanetView
  busy: boolean
  onToggle: (enabled: boolean) => void
  onVeto: () => void
}) {
  const s = view.stats
  return (
    <div className="panel-box" style={{ padding: '12px 14px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong>{label}</strong>
        <span className="dim mono" style={{ fontSize: 11 }}>datanet {id}</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" disabled={busy} onClick={() => onToggle(!view.enabled)}>
          {view.enabled ? 'Disable learning' : 'Enable learning'}
        </button>
        {view.lessons.length > 0 && <button className="btn ghost sm" disabled={busy} onClick={onVeto}>Clear lessons</button>}
      </div>
      <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
        {s.maturedTotal === 0
          ? 'gathering data — no matured outcomes yet'
          : `${s.maturedTotal} matured · votes aligned ${s.voteAlignmentPct}% (${s.voteTotal}) · mints net-up ${s.mintAlignmentPct}% (${s.mintTotal}) · high-conviction reversals ${s.highConvictionReversals}`}
      </div>
      {view.econ && (
        <div className="dim" style={{ fontSize: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span>
            mint ROI {view.econ.mintRoiPct === null ? '—' : `${fmt(view.econ.mintRoiPct)}%`}
            {' '}({fmt(view.econ.ownerClaimedReppo)} earned / {fmt(view.econ.mintCostReppo)} REPPO spent)
            {' · voter earns '}{fmtPerVote(view.econ.voterReppoPerVote)}
            {' · current yield '}{fmtPerVote(view.econ.latestYieldPerVote)}
          </span>
          {view.econ.latestUncontested && <span className="econ-badge uncontested">uncontested</span>}
        </div>
      )}
      {!view.enabled ? (
        <div className="empty">learning disabled for this datanet — lessons are not injected</div>
      ) : view.lessons.length === 0 ? (
        <div className="empty">no lessons yet</div>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          {view.lessons.map((l) => (
            <li key={l.id} style={{ marginBottom: 4, fontSize: 13 }}>
              {l.text} {l.source === 'consensus-flag' && <span className="pill skip">review</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
