import { useCallback, useEffect, useState } from 'react'
import { loadLearn, decideProposal, setLearnEnabled, vetoLessons, type LearnData } from '../api'
import { ProposalCard } from './ProposalCard'
import { LessonsPanel } from './LessonsPanel'

/** The Learning tab: what the node has learned from its own past cycles. Shows pending
 *  config proposals (operator Accept/Dismiss) and the per-datanet learned lessons with
 *  enable/disable + clear (veto) controls. Self-fetches and refreshes after each action. */
export function LearningTab({ netNames, onConfigChanged }: {
  netNames: Record<string, string>
  onConfigChanged: () => void
}) {
  const [data, setData] = useState<LearnData | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setData(await loadLearn()); setErr(null) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const label = (id: string) => netNames[id] || `datanet ${id}`

  const decide = async (id: number, decision: 'accept' | 'reject') => {
    setBusy(true)
    const r = await decideProposal(id, decision)
    setBusy(false)
    if (!r.ok && r.error) setErr(r.error)
    await load()
    if (decision === 'accept' && r.ok) onConfigChanged() // refresh the Strategy tab's config
  }
  const toggle = async (id: string, enabled: boolean) => { setBusy(true); await setLearnEnabled(id, enabled); setBusy(false); await load() }
  const veto = async (id: string) => { setBusy(true); await vetoLessons(id); setBusy(false); await load() }

  if (!data) return <div className="empty">{err ? `load error: ${err}` : 'loading…'}</div>

  const datanetIds = Object.keys(data.datanets)
  return (
    <div key="learning">
      <div className="sec-head"><h2>Proposed changes</h2><div className="rule" /></div>
      {data.proposals.length === 0 ? (
        <div className="empty">no pending proposals — the node suggests a strictness / voteBand change only when its own outcomes clearly justify one</div>
      ) : (
        data.proposals.map((p) => <ProposalCard key={p.id} p={p} label={label(p.datanetId)} busy={busy} onDecide={decide} />)
      )}

      <div className="sec-head"><h2>Learned lessons</h2><div className="rule" /></div>
      <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
        Distilled from this node's own matured outcomes and fed into the judge prompt. Crowd-alignment is a calibration check, never a "follow the crowd" target. Disable or clear to veto.
      </div>
      {err && <div className="empty">error: {err}</div>}
      {datanetIds.length === 0 ? (
        <div className="empty">no vote/mint datanets configured</div>
      ) : (
        datanetIds.map((id) => (
          <LessonsPanel key={id} id={id} label={label(id)} view={data.datanets[id]} busy={busy} onToggle={(en) => toggle(id, en)} onVeto={() => veto(id)} />
        ))
      )}
    </div>
  )
}
