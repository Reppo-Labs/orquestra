import { useEffect, useRef, useState } from 'react'
import type { ChatMsg } from '../api'
import { strategyChat } from '../api'
import type { Strategy, Candidate } from '../lib/useStrategy'

interface LogEntry { role: 'user' | 'assistant'; text: string; warn?: string }

const SUGGESTIONS = [
  'Be more aggressive on geopolitics',
  'Activate sports on datanet 11',
  'Lower my mint budget to 200 REPPO',
  'What is my current strategy?',
]

// The strategy assistant gets its own tab so its purpose is unambiguous: describe a
// goal in plain language, it proposes a full config; the proposal loads into the
// shared candidate and a banner offers to Save now or review it on the Strategy tab.
export function ChatTab({ strategy, onGoToStrategy }: {
  strategy: Strategy; onGoToStrategy: () => void
}) {
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [log, setLog] = useState<LogEntry[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [log, busy])

  const send = async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || busy) return
    setInput('')
    const messages: ChatMsg[] = [...chat, { role: 'user', content: msg }]
    setChat(messages)
    setLog((l) => [...l, { role: 'user', text: msg }])
    setBusy(true)
    try {
      const { ok, out } = await strategyChat(messages)
      if (!ok) { setLog((l) => [...l, { role: 'assistant', text: out.error || 'request failed' }]); return }
      setChat((c) => [...c, { role: 'assistant', content: out.reply }])
      setLog((l) => [...l, { role: 'assistant', text: out.reply, warn: out.warning }])
      if (out.proposedConfig) strategy.applyProposal(out.proposedConfig as Candidate)
    } finally { setBusy(false) }
  }

  return (
    <div className="chat-wrap">
      {strategy.proposalLoaded && (
        <div className="proposal-banner">
          <span className="grow">A proposal is loaded into your strategy — review the diff before it goes live.</span>
          <button className="btn ghost sm" onClick={onGoToStrategy}>Review</button>
          <button className="btn primary sm" onClick={() => void strategy.save()}>Save</button>
        </div>
      )}
      {log.length === 0 && (
        <div className="chat-intro">
          <b>Orquestra assistant.</b> Describe a goal and I'll propose a strategy change — nothing is applied until you save.
          Try a suggestion below or ask about your current setup.
        </div>
      )}
      <div className="chat-scroll" ref={scrollRef}>
        {log.map((e, i) => (
          <div className={`msg ${e.role}`} key={i}>
            <div className="who">{e.role === 'user' ? 'you' : 'orquestra'}</div>
            {e.text}{e.warn ? <span className="warn"> ({e.warn})</span> : null}
          </div>
        ))}
        {busy && <div className="msg assistant typing">thinking…</div>}
      </div>
      {log.length === 0 && (
        <div className="row wrap" style={{ marginBottom: 12 }}>
          {SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>)}
        </div>
      )}
      <div className="chat-compose">
        <input
          type="text" placeholder={busy ? 'waiting for the assistant…' : 'set a goal or ask about your strategy…'}
          value={input} disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void send() }}
        />
        <button className="btn primary" disabled={busy} onClick={() => void send()}>Send</button>
      </div>
    </div>
  )
}
