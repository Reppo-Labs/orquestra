import { useState } from 'react'
import { runNow } from '../api'

// Header action: trigger an off-schedule cycle. The scheduler enforces no-overlap, so a
// click while a cycle runs is a harmless no-op (the node replies started:false + reason).
// After a successful trigger we poll the dashboard a few times so the new activity/PnL
// lands without waiting for the 30s auto-refresh.
export function RunNowButton({ onRefresh }: { onRefresh: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const click = async () => {
    if (busy) return
    setBusy(true)
    setMsg('')
    try {
      const r = await runNow()
      if (r.started) {
        setMsg('cycle started')
        // A cycle takes a while; nudge a few refreshes so results appear as they land.
        for (const d of [1500, 5000, 12000]) setTimeout(onRefresh, d)
      } else {
        setMsg(r.reason ?? r.error ?? 'could not start')
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'request failed')
    } finally {
      setBusy(false)
      // Clear the note after a beat so the header doesn't keep stale text.
      setTimeout(() => setMsg(''), 6000)
    }
  }

  return (
    <span className="run-now">
      {msg && <span className="run-now-msg">{msg}</span>}
      <button className="btn primary sm" onClick={() => void click()} disabled={busy}
        title="Trigger a cycle now instead of waiting for the next scheduled run">
        {busy ? 'running…' : 'Run now'}
      </button>
    </span>
  )
}
