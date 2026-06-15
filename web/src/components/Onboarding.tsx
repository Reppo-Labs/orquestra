import { useEffect, useRef, useState } from 'react'
import {
  onboardingChat, onboardingConfirm,
  type OnboardingAnswers, type OnboardingDraft, type OnboardingStatus,
} from '../api'
import { fmt } from '../lib/format'

// Full-screen first-run experience: chat with the onboarding assistant on the
// left while the strategy "score sheet" materializes on the right. Nothing is
// saved until the operator hits Confirm (POST /api/onboarding/confirm).

interface LogEntry { role: 'user' | 'assistant'; text: string }

const CHIPS = [
  'What datanets are available?',
  'Start vote-only on the safest datanets',
  'I want to mint geopolitical analysis',
  'Use a small test budget',
]

function Field({ label, value }: { label: string; value: string | number | undefined | null }) {
  const set = value !== undefined && value !== null && value !== ''
  return (
    <div className="ob-field">
      <span className="k">{label}</span>
      <span className={`v ${set ? 'set' : ''}`}>{set ? String(value) : '—'}</span>
    </div>
  )
}

function DraftSheet({ draft, names }: { draft: OnboardingDraft; names: Record<string, string> }) {
  const nets = draft.datanets ?? []
  return (
    <>
      <div className="ob-section">datanets</div>
      {nets.length === 0 && <div className="muted">none chosen yet — they appear as you decide</div>}
      {nets.map((d) => (
        <div className="ob-net" key={d.id}>
          <div className="ob-net-head">
            <strong>{names[d.id] ? `${d.id} — ${names[d.id]}` : `datanet ${d.id}`}</strong>
            <span>
              {d.vote && <span className="pill vote">vote</span>}{' '}
              {d.mint && <span className="pill mint">mint</span>}
            </span>
          </div>
          <div className="muted">
            strictness {d.strictness}{d.adapter ? ` · adapter ${d.adapter}` : ''}
          </div>
          {d.adapterParams?.focus && <div className="muted">focus: {d.adapterParams.focus}</div>}
          {d.adapterParams?.angle && <div className="muted">angle: {d.adapterParams.angle}</div>}
        </div>
      ))}
      <div className="ob-section">stake</div>
      <Field label="lock REPPO" value={draft.lockReppo} />
      <Field label="lock days" value={draft.lockDurationDays} />
      <div className="ob-section">budget</div>
      <Field label="votes / cycle" value={draft.voteRateMaxPerCycle} />
      <Field label="mint REPPO max" value={draft.mintReppoMax} />
      <div className="ob-section">rhythm</div>
      <Field label="horizon (days)" value={draft.horizonDays} />
      <Field label="cadence (hours)" value={draft.cadenceHours} />
      {draft.notes && (
        <>
          <div className="ob-section">strategy brief</div>
          <div className="ob-notes">{draft.notes}</div>
        </>
      )}
    </>
  )
}

export function Onboarding({ status, netNames, onDone, onCancel }: {
  status: OnboardingStatus
  netNames: Record<string, string>
  onDone: () => void
  /** present when reconfiguring an already-onboarded node — shows a way back */
  onCancel?: () => void
}) {
  const [started, setStarted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<LogEntry[]>([])
  const [input, setInput] = useState('')
  const [draft, setDraft] = useState<OnboardingDraft>({})
  const [finalized, setFinalized] = useState<OnboardingAnswers | null>(null)
  const [confirmMsg, setConfirmMsg] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log, busy])

  const turn = async (message?: string) => {
    setBusy(true)
    try {
      const { ok, out } = await onboardingChat(message ? { message } : {})
      if (!ok) { setLog((l) => [...l, { role: 'assistant', text: out.error || 'request failed' }]); return }
      if (out.reply) setLog((l) => [...l, { role: 'assistant', text: out.reply! }])
      if (out.draft) setDraft(out.draft)
      if (out.finalized) { setFinalized(out.finalized); setDraft(out.finalized) }
    } finally { setBusy(false) }
  }

  const begin = async () => {
    setStarted(true)
    // Start from a clean server session. A prior conversation (e.g. a reconfigure the
    // operator abandoned mid-chat) may still be held server-side and would otherwise
    // resume — even echoing a stale finalized strategy. reset is a no-op on a fresh node.
    await onboardingChat({ reset: true })
    await turn()
  }

  const send = async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || busy) return
    setInput('')
    setLog((l) => [...l, { role: 'user', text: msg }])
    await turn(msg)
  }

  const confirm = async () => {
    if (!finalized) return
    setConfirmMsg('saving…')
    const r = await onboardingConfirm(finalized)
    if (!r.ok) { setConfirmMsg(`error: ${r.error}`); return }
    setConfirmMsg('saved — the node starts its first cycle shortly')
    setTimeout(onDone, 1200)
  }

  return (
    <div className="ob-wrap">
      <div className="ob-hero">
        {onCancel && <a href="#" onClick={(e) => { e.preventDefault(); onCancel() }}>← back to dashboard</a>}
        <h1 className="ob-title">orquestra</h1>
        <p className="ob-sub">Let's set up your node — what to vote and mint, how much to spend, and how often to run. Chat below; your strategy takes shape on the right. Nothing is saved until you confirm.</p>
      </div>
      {!status.chatAvailable && (
        <div className="ob-warn">
          The onboarding assistant needs an LLM — start the node with <code>LLM_PROVIDER</code> + <code>LLM_API_KEY</code> set.
        </div>
      )}
      <div className="ob-grid">
        <div className="ob-chat">
          {!started ? (
            <div className="ob-start">
              <button className="btn primary" disabled={!status.chatAvailable} onClick={() => void begin()}>
                Start onboarding
              </button>
            </div>
          ) : (
            <>
              <div className="chat-log ob-log" ref={logRef}>
                {log.map((e, i) => (
                  <div key={i} className={`ob-msg ${e.role}`}>
                    <span className={e.role === 'user' ? 'muted' : 'pos'}>{e.role === 'user' ? 'you' : 'orquestra'}:</span> {e.text}
                  </div>
                ))}
                {busy && <div className="muted">thinking…</div>}
              </div>
              {!finalized && (
                <div className="ob-chips">
                  {CHIPS.map((c) => (
                    <button key={c} className="chip" disabled={busy} onClick={() => void send(c)}>{c}</button>
                  ))}
                </div>
              )}
              <div className="row">
                <input
                  type="text" className="chat-input" placeholder={busy ? 'waiting for the assistant…' : 'reply…'}
                  value={input} disabled={busy}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void send() }}
                />
                <button className="btn" disabled={busy} onClick={() => void send()}>Send</button>
              </div>
            </>
          )}
        </div>
        <div className={`ob-sheet ${finalized ? 'final' : ''}`}>
          <div className="ob-sheet-head">
            {finalized ? 'final strategy — review & confirm' : 'your strategy (live draft)'}
          </div>
          <DraftSheet draft={draft} names={netNames} />
          {finalized && (
            <div className="ob-confirm">
              <button className="btn primary" onClick={() => void confirm()}>Confirm & start the node</button>
              <span className="muted"> {confirmMsg}</span>
              <div className="muted" style={{ marginTop: 6 }}>
                want changes? just keep chatting — the assistant will re-finalize. ({fmt(draft.mintReppoMax)} REPPO mint cap)
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
