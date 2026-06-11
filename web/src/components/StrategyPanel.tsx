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
// Must match the Strictness enum in src/config/schema.ts — anything else 400s on Save.
const STRICT = ['conservative', 'balanced', 'aggressive']

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

interface LogEntry { role: 'user' | 'assistant'; text: string; warn?: string }

function Num({ label, value, int, onChange }: {
  label: string
  value: number | undefined
  int?: boolean
  /** undefined = field cleared (caller decides: delete the key or ignore) */
  onChange: (n: number | undefined) => void
}) {
  return (
    <label>
      {label}
      <input
        type="number" min={0} step={int ? 1 : 'any'} value={value ?? ''}
        onChange={(e) => {
          if (e.target.value === '') { onChange(undefined); return }
          const n = int ? parseInt(e.target.value, 10) : parseFloat(e.target.value)
          if (!Number.isNaN(n)) onChange(n)
        }}
      />
    </label>
  )
}

export function StrategyPanel({ config, netNames, onReconfigure }: {
  config: StrategyConfig
  netNames: Record<string, string>
  onReconfigure: () => void
}) {
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [baseline, setBaseline] = useState<Candidate | null>(null)
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [log, setLog] = useState<LogEntry[]>([])
  const [token, setToken] = useState('')
  const [input, setInput] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const [status, setStatus] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
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

  const edit = (fn: (c: Candidate) => void) => {
    setCandidate((prev) => {
      if (!prev) return prev
      const next = clone(prev)
      fn(next)
      return next
    })
  }
  const updateNet = (id: string, fn: (d: DatanetEntry) => void) => edit((c) => fn(c.datanets[id]))
  const setParam = (id: string, key: 'focus' | 'angle' | 'topN' | 'minImportance', v: string | number | undefined) =>
    updateNet(id, (d) => {
      const p = { ...(d.adapterParams ?? {}) } as Record<string, unknown>
      if (v === undefined || v === '') delete p[key]
      else p[key] = v
      if (Object.keys(p).length) d.adapterParams = p
      else delete d.adapterParams
    })

  const addNet = () => {
    const id = prompt('datanet id (integer):')
    if (id && /^\d+$/.test(id)) edit((c) => { c.datanets[id] = { vote: true, mint: false, strictness: 'balanced' } })
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

  const budget = candidate.budget ?? {}
  const stake = candidate.stake ?? {}
  const delib = candidate.deliberation ?? {}
  const params = (d: DatanetEntry) => (d.adapterParams ?? {}) as { focus?: string; angle?: string; topN?: number; minImportance?: number }

  return (
    <>
      <h2>
        Strategy <span className="muted">{status}</span>
        <button className="btn ghost" style={{ float: 'right' }} onClick={onReconfigure}>↻ reconfigure with assistant</button>
      </h2>
      <table>
        <thead><tr><th>Datanet</th><th>Vote</th><th>Mint</th><th>Adapter</th><th>Strictness</th><th></th></tr></thead>
        <tbody>
          {rows.map(([id, d]) => (
            [
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
                <td>
                  <button className="btn ghost" onClick={() => setExpanded((x) => ({ ...x, [id]: !x[id] }))}>
                    {expanded[id] ? '▾' : '▸'} strategy
                  </button>
                </td>
              </tr>,
              expanded[id] ? (
                <tr key={`${id}-params`} className="params-row">
                  <td colSpan={6}>
                    <div className="settings">
                      <label>focus
                        <input type="text" placeholder="regions / topics / keywords" value={params(d).focus ?? ''}
                          onChange={(e) => setParam(id, 'focus', e.target.value)} />
                      </label>
                      <label>angle
                        <input type="text" placeholder="stance — e.g. contrarian, risk-focused" value={params(d).angle ?? ''}
                          onChange={(e) => setParam(id, 'angle', e.target.value)} />
                      </label>
                      <Num label="items / cycle (topN)" int value={params(d).topN} onChange={(n) => setParam(id, 'topN', n)} />
                      <Num label="min importance (1-10)" int value={params(d).minImportance} onChange={(n) => setParam(id, 'minImportance', n)} />
                    </div>
                  </td>
                </tr>
              ) : null,
            ]
          ))}
          <tr><td colSpan={6}><button className="btn ghost" onClick={addNet}>+ add datanet</button></td></tr>
        </tbody>
      </table>

      <div className="settings">
        <Num label="cadence (hours)" int value={candidate.cadenceHours} onChange={(n) => { if (n !== undefined) edit((c) => { c.cadenceHours = n }) }} />
        <Num label="horizon (days)" int value={candidate.horizonDays} onChange={(n) => { if (n !== undefined) edit((c) => { c.horizonDays = n }) }} />
        <Num label="lock REPPO" value={stake.lockReppo} onChange={(n) => { if (n !== undefined) edit((c) => { c.stake = { ...c.stake, lockReppo: n } }) }} />
        <Num label="lock days" int value={stake.lockDurationDays} onChange={(n) => { if (n !== undefined) edit((c) => { c.stake = { ...c.stake, lockDurationDays: n } }) }} />
        <Num label="vote gas max (ETH)" value={budget.voteGasEthMax} onChange={(n) => { if (n !== undefined) edit((c) => { c.budget = { ...c.budget, voteGasEthMax: n } }) }} />
        <Num label="votes / cycle" int value={budget.voteRateMaxPerCycle} onChange={(n) => { if (n !== undefined) edit((c) => { c.budget = { ...c.budget, voteRateMaxPerCycle: n } }) }} />
        <Num label="mint REPPO max" value={budget.mintReppoMax} onChange={(n) => { if (n !== undefined) edit((c) => { c.budget = { ...c.budget, mintReppoMax: n } }) }} />
        <Num label="mint gas max (ETH)" value={budget.mintGasEthMax} onChange={(n) => { if (n !== undefined) edit((c) => { c.budget = { ...c.budget, mintGasEthMax: n } }) }} />
        <Num label="claim gas max (ETH)" value={budget.claimGasEthMax} onChange={(n) => { if (n !== undefined) edit((c) => { c.budget = { ...c.budget, claimGasEthMax: n } }) }} />
        {/* grant cap is genuinely optional: empty = uncapped (∞) */}
        <Num label="grant REPPO max (empty = ∞)" value={budget.grantReppoMax} onChange={(n) => edit((c) => {
          const b = { ...c.budget }
          if (n === undefined) delete b.grantReppoMax
          else b.grantReppoMax = n
          c.budget = b
        })} />
      </div>
      <div className="settings">
        <label>
          multi-agent panel
          <select
            value={delib.enabled === false ? 'off' : 'on'}
            onChange={(e) => edit((c) => { c.deliberation = { ...c.deliberation, enabled: e.target.value === 'on' } })}
          >
            <option value="on">on (bull / bear / rubric-purist + judge)</option>
            <option value="off">off (single scorer)</option>
          </select>
        </label>
        <Num
          label="vote panel band (0 = mints only)" int value={delib.voteBand}
          onChange={(n) => edit((c) => { c.deliberation = { ...c.deliberation, voteBand: n ?? 0 } })}
        />
      </div>
      <label className="notes-label">
        goals / strategy notes (the brief the node votes and mints by)
        <textarea
          rows={3} value={candidate.notes ?? ''}
          onChange={(e) => edit((c) => { c.notes = e.target.value })}
        />
      </label>

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
