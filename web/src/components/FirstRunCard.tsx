import { useState } from 'react'

const DISMISS_KEY = 'orq-firstrun-dismissed'

// Post-onboarding orientation: a fresh node's dashboard is all empty panels, and nothing
// tells the operator the node is autonomous. Shown until the first cycle lands activity
// (or the operator dismisses it — persisted in localStorage).
export function FirstRunCard({ cadenceHours, hasActivity, onGoToActivity, onGoToStrategy }: {
  cadenceHours?: number
  hasActivity: boolean
  onGoToActivity: () => void
  onGoToStrategy: () => void
}) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1')
  if (dismissed || hasActivity) return null
  const dismiss = () => { localStorage.setItem(DISMISS_KEY, '1'); setDismissed(true) }
  return (
    <div className="firstrun">
      <div className="firstrun-head">
        <b>Your node is running — here's what happens next</b>
        <button className="x-btn" aria-label="dismiss" onClick={dismiss}>×</button>
      </div>
      <p>
        The node runs a cycle {cadenceHours ? `every ${cadenceHours}h` : 'on your configured cadence'}.
        Each cycle it votes and mints within your budget — <b>you don't need to do anything</b>.
        Results land in <a href="#" onClick={(e) => { e.preventDefault(); onGoToActivity() }}>Activity</a> as
        they happen, and you can adjust your{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); onGoToStrategy() }}>Strategy</a> anytime —
        changes apply from the next cycle.
      </p>
    </div>
  )
}
