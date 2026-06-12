import { useEffect, useMemo, useState } from 'react'
import type { DatanetEntry } from '../api'

const ADAPTERS = ['', 'gdelt', 'hyperliquid', 'sports']
const STRICT = ['conservative', 'balanced', 'aggressive']

// "Add a datanet" dialog. The datanet is picked BY NAME from the live catalog
// (/api/datanets id→name map) — ids never surface in the UI. Already-configured
// datanets are excluded from the list.
export function AddDatanetModal({ existing, netNames, onAdd, onClose }: {
  existing: string[]
  netNames: Record<string, string>
  onAdd: (id: string, entry: DatanetEntry) => void
  onClose: () => void
}) {
  const [selectedId, setSelectedId] = useState('')
  const [vote, setVote] = useState(true)
  const [mint, setMint] = useState(false)
  const [adapter, setAdapter] = useState('')
  const [strictness, setStrictness] = useState('balanced')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Catalog minus what's already configured, alphabetical by name.
  const available = useMemo(
    () => Object.entries(netNames)
      .filter(([id]) => !existing.includes(id))
      .sort(([, a], [, b]) => a.localeCompare(b)),
    [netNames, existing],
  )

  const canAdd = selectedId !== '' && (vote || mint)

  const submit = () => {
    if (!canAdd) return
    const entry: DatanetEntry = { vote, mint, strictness, ...(adapter ? { adapter } : {}) }
    onAdd(selectedId, entry)
    onClose()
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Add a datanet</h3>
        <div className="sub">Point the node at another Reppo datanet. It activates on the next cycle once you save.</div>
        <div className="fields">
          <label className="field">
            <span>datanet</span>
            {available.length > 0 ? (
              <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} autoFocus>
                <option value="" disabled>choose a datanet…</option>
                {available.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>
                {Object.keys(netNames).length === 0
                  ? 'datanet catalog still loading — try again in a moment'
                  : 'every active datanet is already configured'}
              </span>
            )}
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
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!canAdd} onClick={submit}>Add datanet</button>
        </div>
      </div>
    </div>
  )
}
