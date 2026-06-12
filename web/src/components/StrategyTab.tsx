import { useState } from 'react'
import type { DatanetEntry } from '../api'
import type { Strategy, Candidate } from '../lib/useStrategy'
import { netLabel } from '../lib/format'
import { AddDatanetModal } from './AddDatanetModal'

const ADAPTERS = ['', 'gdelt', 'hyperliquid', 'sports']
const STRICT = ['conservative', 'balanced', 'aggressive']

function Num({ label, value, int, onChange }: {
  label: string; value: number | undefined; int?: boolean; onChange: (n: number | undefined) => void
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number" min={0} step={int ? 1 : 'any'} value={value ?? ''}
        onChange={(e) => {
          if (e.target.value === '') return onChange(undefined)
          const n = int ? parseInt(e.target.value, 10) : parseFloat(e.target.value)
          if (!Number.isNaN(n)) onChange(n)
        }}
      />
    </label>
  )
}

type Params = { focus?: string; angle?: string; topN?: number; minImportance?: number }

function NetCard({ id, d, name, edit }: {
  id: string; d: DatanetEntry; name: string; edit: Strategy['edit']
}) {
  const [open, setOpen] = useState(false)
  const upd = (fn: (n: DatanetEntry) => void) => edit((c) => fn(c.datanets[id]))
  const p = (d.adapterParams ?? {}) as Params
  const setParam = (key: keyof Params, v: string | number | undefined) =>
    upd((n) => {
      const next = { ...(n.adapterParams ?? {}) } as Record<string, unknown>
      if (v === undefined || v === '') delete next[key]
      else next[key] = v
      if (Object.keys(next).length) n.adapterParams = next
      else delete n.adapterParams
    })

  return (
    <div className={`net ${d.mint ? 'active-mint' : ''}`}>
      <div className="net-top">
        <div>
          <div className="net-id mono">datanet {id}</div>
          <div className="net-name">{name || '—'}</div>
        </div>
        <div className="net-acts">
          <span className={`chip-toggle vote ${d.vote ? 'on' : ''}`} onClick={() => upd((n) => { n.vote = !n.vote })}>vote</span>
          <span className={`chip-toggle mint ${d.mint ? 'on' : ''}`} onClick={() => upd((n) => { n.mint = !n.mint })}>mint</span>
        </div>
      </div>
      <div className="net-row">
        <label className="field">
          <span>adapter</span>
          <select value={d.adapter ?? ''} onChange={(e) => upd((n) => { if (e.target.value) n.adapter = e.target.value; else delete n.adapter })}>
            {ADAPTERS.map((a) => <option key={a} value={a}>{a || '—'}</option>)}
          </select>
        </label>
        <label className="field">
          <span>strictness</span>
          <select value={d.strictness} onChange={(e) => upd((n) => { n.strictness = e.target.value })}>
            {STRICT.map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
      </div>
      <div className={`net-strategy ${open ? '' : 'collapsed'}`}>
        <label className="field">
          <span>focus</span>
          <input type="text" placeholder="regions / topics / keywords" value={p.focus ?? ''} onChange={(e) => setParam('focus', e.target.value)} />
        </label>
        <label className="field">
          <span>angle</span>
          <input type="text" placeholder="stance — e.g. contrarian, risk-focused" value={p.angle ?? ''} onChange={(e) => setParam('angle', e.target.value)} />
        </label>
        <div className="net-row">
          <Num label="items / cycle" int value={p.topN} onChange={(n) => setParam('topN', n)} />
          <Num label="min importance" int value={p.minImportance} onChange={(n) => setParam('minImportance', n)} />
        </div>
      </div>
      <div className="net-foot">
        <button className="link-btn" onClick={() => setOpen((o) => !o)}>{open ? '− hide strategy' : '+ mint strategy'}</button>
        <button className="link-btn" onClick={() => edit((c) => { delete c.datanets[id] })}>remove</button>
      </div>
    </div>
  )
}

export function StrategyTab({ strategy, netNames, onReconfigure }: {
  strategy: Strategy; netNames: Record<string, string>; onReconfigure: () => void
}) {
  const [adding, setAdding] = useState(false)
  const { candidate, edit } = strategy
  if (!candidate) return <div className="muted">loading strategy…</div>

  const rows = Object.entries(candidate.datanets).filter(([id]) => id !== '*')
  const budget = candidate.budget ?? {}
  const stake = candidate.stake ?? {}
  const delib = candidate.deliberation ?? {}
  const setB = (k: string, n: number | undefined, optional = false) => edit((c) => {
    const b = { ...c.budget } as Record<string, number | undefined>
    if (optional && n === undefined) delete b[k]; else b[k] = n
    c.budget = b as Candidate['budget']
  })

  return (
    <div>
      <div className="sec-head">
        <h2>Datanets</h2><div className="rule" />
        <button className="btn ghost sm" onClick={onReconfigure}>↻ reconfigure with assistant</button>
      </div>
      <div className="net-grid stagger">
        {rows.map(([id, d]) => (
          <NetCard key={id} id={id} d={d} name={netNames[id] ?? netLabel(id, netNames)} edit={edit} />
        ))}
        <button className="net add" onClick={() => setAdding(true)}>
          <div style={{ textAlign: 'center' }}><div className="plus">+</div><div>add datanet</div></div>
        </button>
      </div>

      <div className="sec-head"><h2>Budget &amp; cadence</h2><div className="rule" /></div>
      <div className="settings">
        <Num label="cadence (hours, e.g. 0.5 = 30m)" value={candidate.cadenceHours} onChange={(n) => n !== undefined && edit((c) => { c.cadenceHours = n })} />
        <Num label="horizon (days)" int value={candidate.horizonDays} onChange={(n) => n !== undefined && edit((c) => { c.horizonDays = n })} />
        <Num label="lock REPPO" value={stake.lockReppo} onChange={(n) => n !== undefined && edit((c) => { c.stake = { ...c.stake, lockReppo: n } })} />
        <Num label="lock days" int value={stake.lockDurationDays} onChange={(n) => n !== undefined && edit((c) => { c.stake = { ...c.stake, lockDurationDays: n } })} />
        <Num label="vote gas max (ETH)" value={budget.voteGasEthMax} onChange={(n) => n !== undefined && setB('voteGasEthMax', n)} />
        <Num label="votes / cycle" int value={budget.voteRateMaxPerCycle} onChange={(n) => n !== undefined && setB('voteRateMaxPerCycle', n)} />
        <Num label="mint REPPO max" value={budget.mintReppoMax} onChange={(n) => n !== undefined && setB('mintReppoMax', n)} />
        <Num label="mint gas max (ETH)" value={budget.mintGasEthMax} onChange={(n) => n !== undefined && setB('mintGasEthMax', n)} />
        <Num label="claim gas max (ETH)" value={budget.claimGasEthMax} onChange={(n) => n !== undefined && setB('claimGasEthMax', n)} />
        <Num label="grant REPPO max (∞ if empty)" value={budget.grantReppoMax} onChange={(n) => setB('grantReppoMax', n, true)} />
      </div>

      <div className="sec-head"><h2>Deliberation</h2><div className="rule" /></div>
      <div className="settings">
        <label className="field">
          <span>multi-agent panel</span>
          <div className="row">
            <label className="switch">
              <input type="checkbox" checked={delib.enabled !== false}
                onChange={(e) => edit((c) => { c.deliberation = { ...c.deliberation, enabled: e.target.checked } })} />
              <span className="track" />
            </label>
            <span className="muted" style={{ fontSize: 12 }}>{delib.enabled !== false ? 'bull · bear · rubric-purist + judge' : 'single scorer'}</span>
          </div>
        </label>
        <Num label="vote panel band (0 = mints only)" int value={delib.voteBand}
          onChange={(n) => edit((c) => { c.deliberation = { ...c.deliberation, voteBand: n ?? 0 } })} />
      </div>

      <div className="sec-head"><h2>Strategy brief</h2><div className="rule" /></div>
      <label className="notes-label">
        <span className="field-label">the goals the node votes and mints by — the panel judge applies this stance</span>
        <textarea rows={4} value={candidate.notes ?? ''} onChange={(e) => edit((c) => { c.notes = e.target.value })} />
      </label>

      <SaveBar strategy={strategy} />

      {adding && (
        <AddDatanetModal
          existing={rows.map(([id]) => id)}
          netNames={netNames}
          onAdd={(id, entry) => edit((c) => { c.datanets[id] = entry })}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  )
}

export function SaveBar({ strategy }: { strategy: Strategy }) {
  const { diff, save, saveMsg } = strategy
  return (
    <div className="savebar">
      <button className="btn primary" onClick={() => void save()}>Save — applies next cycle</button>
      <span className={`diff-line ${diff.length ? 'dirty' : ''}`}>
        {diff.length ? `${diff.length} unsaved change${diff.length > 1 ? 's' : ''}: ${diff.join(' · ')}` : 'no changes since last save'}
      </span>
      <div style={{ flex: 1 }} />
      {saveMsg && <span className="muted mono" style={{ fontSize: 12 }}>{saveMsg}</span>}
    </div>
  )
}
