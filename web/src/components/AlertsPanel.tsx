// The alert surface: what is wrong, why it matters, and the one control that fixes it.
//
// "DISMISSIBLE-BUT-HONEST" — the contract this component keeps:
//  - Dismissing an alert hides the CARD. It does not clear the condition, and it does NOT
//    clear the header badge: the node is still broken and the operator is still told so.
//  - Dismissed alerts stay counted, and a "N dismissed — still unresolved" line brings them
//    straight back.
//  - Severity is part of the dismissal key (lib/alerts.ts), so a condition that ESCALATES
//    (warning → critical) re-surfaces instead of staying buried under an old dismissal.
// Anything else would be a mute button that lies about the state of the node.
//
// Remedies are the SAME actionPlan wiring the Datanets rows use — a broken thing is never a
// dead end, and there is exactly one remedy path in the product, not two.
import { useCallback, useEffect, useState } from 'react'
import { runNow, type Snapshot } from '../api'
import type { Strategy } from '../lib/useStrategy'
import type { Alert, Severity } from '../lib/alerts'
import { applyDisable } from '../lib/datanetStatus'
import { fmtEth, fmtReppo } from '../lib/format'

// Matches the FirstRunCard convention (`orq-firstrun-dismissed`).
const STORE_KEY = 'orq-alerts-dismissed'

const readDismissed = (): string[] => {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const v: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return [] // a corrupt or unavailable store must never HIDE an alert
  }
}

/** Dismissals survive reloads — an alert the operator has decided to live with should not
 *  nag on every 30s poll. The CONDITION is untouched; only the card is hidden. */
export function useDismissed(): {
  dismissed: Set<string>
  dismiss: (id: string) => void
  restore: () => void
} {
  const [ids, setIds] = useState<string[]>(() => readDismissed())
  const persist = useCallback((next: string[]) => {
    setIds(next)
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)) } catch { /* storage off — in-memory only */ }
  }, [])
  return {
    dismissed: new Set(ids),
    dismiss: useCallback((id: string) => persist([...new Set([...readDismissed(), id])]), [persist]),
    restore: useCallback(() => persist([]), [persist]),
  }
}

const SEV_WORD: Record<Severity, string> = {
  critical: 'Needs you now',
  warning: 'Not working',
  info: 'For information',
}

/** The header badge. Visible on EVERY tab — an operator who never opens Home must still learn
 *  that their node has been dead for three days. Counts DISMISSED alerts too: clicking "×"
 *  tidies the screen, it does not fix the node. */
export function AlertBadge({ count, worst, onClick }: {
  count: number
  worst: Severity | null
  onClick: () => void
}) {
  if (count === 0 || !worst) return null
  return (
    <button
      className={`alert-badge ${worst}`}
      onClick={onClick}
      aria-label={`${count} ${count === 1 ? 'alert' : 'alerts'} need attention — ${SEV_WORD[worst].toLowerCase()}`}
    >
      <span className="ab-dot" aria-hidden="true" />
      {count} {count === 1 ? 'alert' : 'alerts'}
    </button>
  )
}

/** One alert, with its remedy. */
function AlertCard({ alert, strategy, snapshot, onDismiss, onOpenCaps, onGoTo }: {
  alert: Alert
  strategy: Strategy
  snapshot: Snapshot | null
  onDismiss: () => void
  onOpenCaps: () => void
  onGoTo: (tab: 'datanets' | 'diagnostics') => void
}) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [explain, setExplain] = useState(false)
  const { action } = alert

  const scope = action.scope ?? 'all'
  const entry = alert.datanetId ? strategy.candidate?.datanets[alert.datanetId] : undefined
  // A disable button on a datanet that is already off — or has been removed from the strategy
  // entirely — writes nothing and then reports "turned off". The health payload keeps the
  // datanet's old skip rows for 7 days, so that button is offered again on every poll, and
  // the operator can click it forever. Offer it only when it would actually change something.
  const disableWouldChange = !!entry && (entry.mint || (scope === 'all' && entry.vote))
  const deadDisable = action.kind === 'disable' && !disableWouldChange

  const act = async () => {
    switch (action.kind) {
      case 'disable': {
        const id = alert.datanetId
        if (!id || !disableWouldChange) return
        setBusy(true)
        setMsg('')
        try {
          // SCOPED (see datanetStatus.disableScope): a mint-side fault turns PUBLISHING off.
          // Voting costs no REPPO in fees and is the only path that earns without spending —
          // switching it off to fix a mint fault destroys income the operator never agreed to
          // give up, and the message right above this button says "voting still works".
          const res = await strategy.editAndSave((c) => {
            const d = c.datanets[id]
            if (d) applyDisable(d, scope)
          })
          // Only an explicit { ok:false } is a failure (see HomeTab.stopMinting).
          setMsg(res?.ok !== false
            ? (scope === 'mint'
                ? 'publishing off — voting still runs. Applies next cycle.'
                : 'turned off — applies next cycle')
            : `not saved: ${res.error ?? 'the node refused the change'}`)
        } finally {
          setBusy(false) // never strand the button on "working…"
        }
        return
      }
      case 'raise_budget':
        onOpenCaps()
        return
      case 'retry': {
        setBusy(true)
        try {
          const r = await runNow()
          setMsg(r.started ? 'cycle started' : (r.reason ?? r.error ?? 'could not start'))
        } finally {
          setBusy(false)
        }
        return
      }
      default:
        // explain_rpc / explain_model_quota / explain_funding are env-level or third-party fixes.
        // The dashboard holds no secrets and cannot perform them — it can only say exactly what to
        // do, and name the system that actually failed.
        setExplain((e) => !e)
    }
  }

  const explainable =
    action.kind === 'explain_rpc' || action.kind === 'explain_model_quota' || action.kind === 'explain_funding'
  const bal = snapshot?.balance

  return (
    <li className={`alert-card ${alert.severity}`}>
      <div className="ac-head">
        <span className={`ac-sev ${alert.severity}`}>{SEV_WORD[alert.severity]}</span>
        <span className="ac-title">{alert.title}</span>
        <button className="ac-dismiss" onClick={onDismiss} aria-label={`Dismiss: ${alert.title}`}>×</button>
      </div>
      <div className="ac-detail muted">{alert.detail}</div>

      <div className="ac-foot">
        {action.kind !== 'none' && !deadDisable && (
          <button
            className="btn ghost sm"
            disabled={busy}
            aria-expanded={explainable ? explain : undefined}
            onClick={() => void act()}
          >
            {busy ? 'working…' : action.label}
          </button>
        )}
        {deadDisable && (
          <span className="muted" style={{ fontSize: 12 }}>
            {entry ? 'already off — nothing left to turn off here' : 'no longer in your strategy'}
          </span>
        )}
        {action.kind === 'none' && alert.link && (
          <button className="btn ghost sm" onClick={() => onGoTo(alert.link as 'datanets' | 'diagnostics')}>
            {alert.link === 'datanets' ? 'Review datanets' : 'Open diagnostics'}
          </button>
        )}
        {msg && <span className="muted" style={{ fontSize: 12 }} role="status">{msg}</span>}
      </div>

      {explain && action.kind === 'explain_rpc' && (
        <div className="remedy-note" role="status">
          The node reads Reppo through <span className="mono">RPC_URL</span> in its{' '}
          <span className="mono">.env</span> — the dashboard cannot change it, because the dashboard
          holds no secrets. Point it at a private endpoint (Alchemy, Infura, your own node) and
          restart the node. A public RPC gets rate-limited and datanets go quiet exactly like this.
        </div>
      )}
      {explain && action.kind === 'explain_model_quota' && (
        <div className="remedy-note" role="status">
          This is your AI model provider — not your node, not your wallet, not Reppo. It stopped
          answering because the account's quota or credit ran out. Open the provider's billing or
          quota page and top it up, or wait for the daily quota to reset. You can also point the
          affected datanet at a model on a provider that still has headroom.
        </div>
      )}
      {explain && action.kind === 'explain_funding' && (
        <div className="remedy-note" role="status">
          Send REPPO (mint fees) or ETH (gas) to the wallet whose key is in the node's{' '}
          <span className="mono">.env</span>. No dashboard action can create funds — it holds no keys.
          {bal && (
            <div className="mono" style={{ marginTop: 6 }}>
              wallet now: {fmtReppo(bal.reppo)} · {fmtEth(bal.eth)}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * The Home alert list. Renders nothing at all when the node is healthy — an empty
 * "no alerts" box is chrome, and this dashboard has enough of it.
 */
export function AlertsPanel({ alerts, strategy, snapshot, dismissed, onDismiss, onRestore, onOpenCaps, onGoTo }: {
  alerts: Alert[]
  strategy: Strategy
  snapshot: Snapshot | null
  dismissed: Set<string>
  onDismiss: (id: string) => void
  onRestore: () => void
  onOpenCaps: () => void
  onGoTo: (tab: 'datanets' | 'diagnostics') => void
}) {
  const visible = alerts.filter((a) => !dismissed.has(a.id))
  const hidden = alerts.length - visible.length

  // Announce arrivals to assistive tech without stealing focus.
  const [announce, setAnnounce] = useState('')
  useEffect(() => {
    setAnnounce(visible.length === 0 ? '' : `${visible.length} alert${visible.length === 1 ? '' : 's'} need attention`)
  }, [visible.length])

  if (alerts.length === 0) return null

  return (
    <section className="alerts" id="alerts" aria-label="Alerts">
      <div className="visually-hidden" role="status">{announce}</div>

      {visible.length > 0 && (
        <ul className="alert-list">
          {visible.map((a) => (
            <AlertCard
              key={a.id}
              alert={a}
              strategy={strategy}
              snapshot={snapshot}
              onDismiss={() => onDismiss(a.id)}
              onOpenCaps={onOpenCaps}
              onGoTo={onGoTo}
            />
          ))}
        </ul>
      )}

      {/* Dismissed ≠ fixed. The count stays, and the alerts come straight back. */}
      {hidden > 0 && (
        <div className="alerts-hidden muted">
          {hidden} dismissed alert{hidden === 1 ? '' : 's'} — still unresolved.{' '}
          <button className="link-btn" onClick={onRestore}>Show {hidden === 1 ? 'it' : 'them'}</button>
        </div>
      )}
    </section>
  )
}
