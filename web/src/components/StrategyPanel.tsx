import { useEffect, useRef, useState } from 'react'
import type { ChatMsg, DatanetEntry, StrategyConfig } from '../api'
import { saveStrategy, strategyChat } from '../api'
import { configDiff } from '../lib/configDiff'
import { netLabel } from '../lib/format'

// candidate = full config we will save; grid/chat both mutate THIS, never the server.
// baseline = last persisted state — the diff is measured against THIS, refreshed only
// on a successful Save. One write path: Save → POST /api/strategy.
type Candidate = StrategyConfig & { datanets: Record<string, DatanetEntry> }

const ADAPTERS = ['', 'gdelt', 'hyperliquid', 'sports']
const STRICT = ['lenient', 'balanced', 'aggressive']

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

interface LogEntry { role: 'user' | 'assistant'; text: string; warn?: string }

export function StrategyPanel({ config, netNames }: { config: StrategyConfig; netNames: Record<string, string> }) {
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [baseline, setBaseline] = useState<Candidate | null>(null)
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [log, setLog] = useState<LogEntry[]>([])
  const [token, setToken] = useState('')
  const [input, setInput] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const [status, setStatus] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  // Initialize ONCE from the first config that has datanets; later polls must not
  // clobber in-flight edits (parity with the legacy !window._candidate guard).
  useEffect(() => {
    if (candidate === null && config && config.datanets) {
      const c = clone(config) as Candidate
      delete c.claimEmissions // safeConfig omits schema-managed fields; keep only what we round-trip
      setCandidate(c)
      setBaseline(clone(c))
    }
  }, [config, candidate])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  if (!candidate) return <h2>Strategy <span className="muted">loading…</span></h2>

  const diff = baseline ? configDiff(baseline, candidate) : []
  const rows = Object.entries(candidate.datanets).filter(([id]) => id !== '*')

  const updateNet = (id: string, fn: (d: DatanetEntry) => void) => {
    setCandidate((prev) => {
      if (!prev) return prev
      const next = clone(prev)
      fn(next.datanets[id])
      return next
    })
  }

  const addNet = () => {
    const id = prompt('datanet id (integer):')
    if (id && /^\d+$/.test(id)) {
      setCandidate((prev) => {
        if (!prev) return prev
        const next = clone(prev)
        next.datanets[id] = { vote: true, mint: false, strictness: 'balanced' }
        return next
      })
    }
  }

  const send = async () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    const messages: ChatMsg[] = [...chat, { role: 'user', content: text }]
    setChat(messages)
    setLog((l) => [...l, { role: 'user', text }])
    const { ok, out } = await strategyChat(messages, token)
    if (!ok) {
      setLog((l) => [...l, { role: 'assistant', text: out.error || 'request failed' }])
      return
    }
    setChat((c) => [...c, { role: 'assistant', content: out.reply }])
    setLog((l) => [...l, { role: 'assistant', text: out.reply, warn: out.warning }])
    if (out.proposedConfig) {
      setCandidate(out.proposedConfig as Candidate)
      setStatus('· proposal loaded — review and Save')
    }
  }

  const save = async () => {
    setSaveMsg('saving…')
    const res = await saveStrategy(candidate, token)
    setSaveMsg(res.ok ? 'saved — applies next cycle' : `error: ${res.error}`)
    if (res.ok) {
      setStatus('')
      // The server now holds what we just sent — rebase the diff so it reads "no changes".
      setBaseline(clone(candidate))
    }
  }

  return (
    <>
      <h2>Strategy <span className="muted">{status}</span></h2>
      <table>
        <thead><tr><th>Datanet</th><th>Vote</th><th>Mint</th><th>Adapter</th><th>Strictness</th></tr></thead>
        <tbody>
          {rows.map(([id, d]) => (
            <tr key={id}>
              <td title={netNames[id] || ''}>{netLabel(id, netNames)}</td>
              <td><input type="checkbox" checked={d.vote} onChange={(e) => updateNet(id, (n) => { n.vote = e.target.checked })} /></td>
              <td><input type="checkbox" checked={d.mint} onChange={(e) => updateNet(id, (n) => { n.mint = e.target.checked })} /></td>
              <td>
                <select value={d.adapter ?? ''} onChange={(e) => updateNet(id, (n) => { if (e.target.value) n.adapter = e.target.value; else delete n.adapter })}>
                  {ADAPTERS.map((a) => <option key={a} value={a}>{a || '—'}</option>)}
                </select>
              </td>
              <td>
                <select value={d.strictness} onChange={(e) => updateNet(id, (n) => { n.strictness = e.target.value })}>
                  {STRICT.map((x) => <option key={x}>{x}</option>)}
                </select>
              </td>
            </tr>
          ))}
          <tr><td colSpan={5}><button className="btn ghost" onClick={addNet}>+ add datanet</button></td></tr>
        </tbody>
      </table>
      <div className="row m8">
        <input
          type="password" className="token-input" placeholder="dashboard token"
          value={token} onChange={(e) => setToken(e.target.value)}
        />
        <button className="btn primary" onClick={save}>Save (applies next cycle)</button>
        <span className="muted">{saveMsg}</span>
      </div>
      <div className={`diff-line ${diff.length ? 'dirty' : ''}`}>
        {diff.length ? `unsaved: ${diff.join(' · ')}` : 'no changes since last save'}
      </div>
      <div className="chat-box">
        <div className="muted" style={{ marginBottom: 6 }}>
          Strategy assistant — describe a goal ("activate sports on 11", "be more aggressive on geopolitics");
          proposals appear in the grid above, nothing applies until you Save.
        </div>
        <div className="chat-log" ref={logRef}>
          {log.map((e, i) => (
            <div key={i}>
              <span className={e.role === 'user' ? 'muted' : 'pos'}>{e.role === 'user' ? 'you' : 'assistant'}:</span>{' '}
              {e.text}{e.warn ? <span className="neg"> ({e.warn})</span> : null}
            </div>
          ))}
        </div>
        <div className="row">
          <input
            type="text" className="chat-input" placeholder="set a goal or ask about your strategy…"
            value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void send() }}
          />
          <button className="btn" onClick={() => void send()}>Send</button>
        </div>
      </div>
    </>
  )
}
