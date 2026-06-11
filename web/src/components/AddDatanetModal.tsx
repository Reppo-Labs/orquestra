import { useEffect, useState } from 'react'
import type { DatanetEntry } from '../api'

const ADAPTERS = ['', 'gdelt', 'hyperliquid', 'sports']
const STRICT = ['conservative', 'balanced', 'aggressive']

// Real "add a datanet" dialog (replaces window.prompt). Validates the id is an
// integer that isn't already configured, previews the on-chain name if known, and
// returns a fully-formed DatanetEntry.
export function AddDatanetModal({ existing, netNames, onAdd, onClose }: {
  existing: string[]
  netNames: Record<string, string>
  onAdd: (id: string, entry: DatanetEntry) => void
  onClose: () => void
}) {
  const [id, setId] = useState('')
  const [vote, setVote] = useState(true)
  const [mint, setMint] = useState(false)
  const [adapter, setAdapter] = useState('')
  const [strictness, setStrictness] = useState('balanced')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const trimmed = id.trim()
  const validId = /^\d+$/.test(trimmed)
  const dup = validId && existing.includes(trimmed)
  const knownName = validId ? netNames[trimmed] : undefined
  const err = trimmed === '' ? '' : !validId ? 'datanet id must be an integer' : dup ? `datanet ${trimmed} is already configured` : ''
  const canAdd = validId && !dup && (vote || mint)

  const submit = () => {
    if (!canAdd) return
    const entry: DatanetEntry = { vote, mint, strictness, ...(adapter ? { adapter } : {}) }
    onAdd(trimmed, entry)
    onClose()
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Add a datanet</h3>
        <div className="sub">Point the node at another Reppo datanet. It activates on the next cycle once you save.</div>
        <div className="fields">
          <label className="field">
            <span>datanet id</span>
            <input
              type="text" inputMode="numeric" placeholder="e.g. 11" value={id} autoFocus
              onChange={(e) => setId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            />
            {knownName && !dup && <span className="faint mono" style={{ fontSize: 12 }}>{knownName}</span>}
          </label>

          <div className="field">
            <span>actions</span>
            <div className="row">
              <span className={`chip-toggle vote ${vote ? 'on' : ''}`} onClick={() => setVote((v) => !v)}>vote</span>
              <span className={`chip-toggle mint ${mint ? 'on' : ''}`} onClick={() => setMint((v) => !v)}>mint</span>
            </div>
          </div>

          <label className="field">
            <span>adapter {mint && !adapter ? '(required to mint)' : ''}</span>
            <select value={adapter} onChange={(e) => setAdapter(e.target.value)}>
              {ADAPTERS.map((a) => <option key={a} value={a}>{a || 'none (vote-only)'}</option>)}
            </select>
          </label>

          <label className="field">
            <span>strictness</span>
            <select value={strictness} onChange={(e) => setStrictness(e.target.value)}>
              {STRICT.map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>

          <div className="modal-err">{err}</div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!canAdd} onClick={submit}>Add datanet</button>
        </div>
      </div>
    </div>
  )
}
