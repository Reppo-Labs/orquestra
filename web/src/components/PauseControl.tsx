import { useState } from 'react'
import { setPaused } from '../api'

// The kill switch. While paused the node signs NOTHING — no votes, no mints, no claims,
// no grants, no locks — and keeps running (src/runtime/cycle.ts refuses at the top of
// runCycle). It is the operator's answer to "make it stop spending my money", so it sits
// in the header, one click away, on every tab.
//
// The `appliesNextCycle` nuance is stated, never hidden: config is hot-reloaded per cycle,
// so a cycle already in flight finishes under the old flag. Claiming "stopped" while a
// cycle is mid-signature would be the same class of lie as the old EARNING pill.

interface Props {
  paused: boolean
  /** Called with the new state once the SERVER has confirmed it. */
  onChanged: (paused: boolean) => void
}

function useToggle({ paused, onChanged }: Props) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const toggle = async () => {
    if (busy) return
    setBusy(true); setErr('')
    try {
      // setPaused never rejects (api.ts): an unreachable node comes back as { ok: false } with
      // a message. It used to REJECT, which skipped setBusy(false) and setErr() both — the
      // emergency stop button locked on "…" forever, silently, while the node kept spending.
      // try/finally is the belt to that braces: whatever happens, the button comes back.
      const r = await setPaused(!paused)
      if (!r.ok) { setErr(r.error ?? 'could not reach the node — the node is still running'); return }
      onChanged(r.paused ?? !paused)
    } catch (e) {
      setErr(e instanceof Error ? `could not reach the node: ${e.message}` : 'could not reach the node')
    } finally {
      setBusy(false)
    }
  }
  return { busy, err, toggle }
}

/** Header control: pause/resume from anywhere. Amber, never red — a paused node has not
 *  lost money, it is simply not acting. */
export function PauseControl(props: Props) {
  const { busy, err, toggle } = useToggle(props)
  return (
    <span className="pause-ctl">
      {err && <span className="pause-err" role="status">{err}</span>}
      <button
        className={`btn sm ${props.paused ? 'resume' : 'ghost'}`}
        aria-pressed={props.paused}
        disabled={busy}
        onClick={() => void toggle()}
        title={props.paused
          ? 'Resume signing — the node votes and mints again from the next cycle'
          : 'Stop all spending — the node keeps running but signs nothing'}
      >
        {busy ? '…' : props.paused ? '▶ Resume node' : '⏸ Pause spending'}
      </button>
    </span>
  )
}

/** The unmissable state. Rendered above every tab while the node is paused, so it is
 *  impossible to stare at a quiet dashboard and wonder why nothing is happening. */
export function PausedBanner(props: Props) {
  const { busy, err, toggle } = useToggle(props)
  if (!props.paused) return null
  return (
    <div className="paused-banner" role="status" aria-label="Node paused">
      <span className="dot warm" aria-hidden="true" />
      <div className="paused-main">
        <div className="paused-head">Node paused — signing nothing.</div>
        <div className="paused-detail muted">
          No votes, no mints, no claims. The node is still running, and it earns nothing while paused.
          A cycle already in progress finishes under the old setting.
        </div>
      </div>
      {err && <span className="pause-err">{err}</span>}
      <button className="btn resume sm" disabled={busy} onClick={() => void toggle()}>
        {busy ? 'resuming…' : 'Resume'}
      </button>
    </div>
  )
}
