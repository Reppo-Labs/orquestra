import { useEffect, useState, type ReactNode } from 'react'
import type { Strategy } from '../lib/useStrategy'
import { Tip } from './Tip'

// Shared form primitives, lifted verbatim out of the old StrategyTab when it split into
// DatanetsTab (per-datanet rows) + NodeSettings (node-wide strategy). Same behaviour,
// two consumers.

export function Num({ label, value, int, onChange, hint }: {
  label: string; value: number | undefined; int?: boolean; onChange: (n: number | undefined) => void; hint?: ReactNode
}) {
  // Local text buffer: a controlled type="number" reports value="" mid-typing for an
  // incomplete decimal ("0."), which would strip the dot before the user can finish.
  // We hold the raw string, parse on every keystroke, and re-sync from the prop only
  // while the field isn't focused (so an external change — e.g. a chat proposal — shows).
  const [text, setText] = useState(value === undefined ? '' : String(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(value === undefined ? '' : String(value))
  }, [value, focused])
  return (
    <label className="field">
      <span>{label}{hint != null && <Tip label={label}>{hint}</Tip>}</span>
      <input
        type="text" inputMode={int ? 'numeric' : 'decimal'} value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const raw = e.target.value
          setText(raw)
          if (raw.trim() === '') return onChange(undefined)
          const n = int ? parseInt(raw, 10) : parseFloat(raw)
          if (!Number.isNaN(n)) onChange(n)
        }}
      />
    </label>
  )
}

/** Sticky footer for the strategy surface: what is unsaved, and the button that saves it.
 *  "applies next cycle" is stated on the control itself — the node hot-reloads config per
 *  cycle, so a save never takes effect mid-cycle and the UI must not imply it does. */
export function SaveBar({ strategy }: { strategy: Strategy }) {
  const { diff, save, saveMsg } = strategy
  return (
    <div className="savebar">
      <button className="btn primary" onClick={() => void save()}>Save changes</button>
      <span className="muted" style={{ fontSize: 12 }}>applies next cycle</span>
      <span className={`diff-line ${diff.length ? 'dirty' : ''}`}>
        {diff.length ? `${diff.length} unsaved change${diff.length > 1 ? 's' : ''}: ${diff.join(' · ')}` : 'no changes since last save'}
      </span>
      <div style={{ flex: 1 }} />
      {saveMsg && <span className="muted mono" style={{ fontSize: 12 }} role="status">{saveMsg}</span>}
    </div>
  )
}
