import { useEffect } from 'react'
import type { ActivityRow, PanelTranscript } from '../api'

// The multi-agent debate, shown as a right-side drawer: a big judge verdict on top,
// then each panelist (bull/bear/purist) as a colour-coded card with a score bar and
// argument. Replaces the cramped inline table-row expansion.
export function PanelDrawer({ row, onClose }: { row: ActivityRow; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const panel = row.panel as PanelTranscript
  const subject = row.podName ?? row.podId ?? row.canonicalKey ?? ''
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="panel deliberation">
        <div className="drawer-head">
          <div>
            <div className="drawer-eyebrow">⚖ {panel.panelists.length}-agent deliberation</div>
            <h3>{row.kind === 'mint' ? 'Mint' : 'Vote'} · datanet {row.datanetId}{subject ? ` · ${subject}` : ''}</h3>
          </div>
          <button className="x-btn" onClick={onClose} aria-label="close">✕</button>
        </div>
        <div className="drawer-body">
          <div className="verdict">
            <div className="score tnum">{panel.judge.score}</div>
            <div className="meta">
              <div className="lbl">judge verdict</div>
              <div className="reason">{panel.judge.reason}</div>
            </div>
          </div>
          {panel.screenScore !== undefined && (
            <div className="screen-note">screen scored {panel.screenScore} → ambiguous, panel convened</div>
          )}
          <div className="debate">
            {panel.panelists.map((p) => (
              <div className={`agent ${p.persona}`} key={p.persona}>
                <div className="agent-top">
                  <span className="agent-name">{p.persona}</span>
                  <span className="agent-score"><b>{p.score}</b> / 10</span>
                </div>
                <div className="score-track"><div style={{ width: `${(p.score / 10) * 100}%` }} /></div>
                <div className="agent-arg">{p.argument}</div>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </>
  )
}
