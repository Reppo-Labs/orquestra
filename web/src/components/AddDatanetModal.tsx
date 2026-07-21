import { useEffect, useMemo, useState } from 'react'
import type { DatanetEntry, ModelProvider } from '../api'
import { Tip } from './Tip'
import { STRICT, STRICT_LABEL, strictnessTip } from '../lib/strictness'

const ADAPTERS = ['', 'gdelt', 'hyperliquid', 'sports']

// "Add a datanet" dialog. The datanet is picked BY NAME from the live catalog
// (/api/datanets id→name map) — ids never surface in the UI. Already-configured
// datanets are excluded from the list.
export function AddDatanetModal({ existing, netNames, providers, onAdd, onClose }: {
  existing: string[]
  netNames: Record<string, string>
  providers: ModelProvider[]
  onAdd: (id: string, entry: DatanetEntry) => void
  onClose: () => void
}) {
  const [selectedId, setSelectedId] = useState('')
  const [vote, setVote] = useState(true)
  const [mint, setMint] = useState(false)
  const [adapter, setAdapter] = useState('')
  const [strictness, setStrictness] = useState<DatanetEntry['strictness']>('balanced')
  const [voteShare, setVoteShare] = useState('1')
  const [modelProvider, setModelProvider] = useState('') // '' = node default
  const [modelSlug, setModelSlug] = useState('')

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
  const curModels = providers.find((p) => p.provider === modelProvider)?.models ?? []

  // Provider (re)selection auto-fills a sensible default slug (mirrors the per-datanet card).
  const selectProvider = (provider: string) => {
    setModelProvider(provider)
    setModelSlug(provider ? (providers.find((p) => p.provider === provider)?.models[0] ?? '') : '')
  }

  const submit = () => {
    if (!canAdd) return
    // Only a positive integer is a valid weight (schema is .int().positive()); anything else
    // ⇒ omit, so the node applies the default of 1.
    const share = parseInt(voteShare, 10)
    const entry: DatanetEntry = {
      vote, mint, strictness,
      ...(adapter ? { adapter } : {}),
      ...(Number.isInteger(share) && share >= 1 ? { voteShare: share } : {}),
      ...(modelProvider && modelSlug ? { model: { provider: modelProvider, model: modelSlug } as DatanetEntry['model'] } : {}),
    }
    onAdd(selectedId, entry)
    onClose()
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Add a datanet" onClick={(e) => e.stopPropagation()}>
        <h3>Add a datanet</h3>
        <div className="sub">Point the node at another Reppo datanet. It activates on the next cycle once you save.</div>
        <div className="fields">
          {/* WHAT is being picked (the datanet) sits in an inset group, one level
              deeper than the modal; actions + tuning fields flow below it. An
              exhausted catalog is a NOTICE (warn), not muted body text. */}
          <div className="inset-group">
            <label className="field">
              <span>datanet</span>
              {available.length > 0 ? (
                <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} autoFocus>
                  <option value="" disabled>choose a datanet…</option>
                  {available.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              ) : Object.keys(netNames).length === 0 ? (
                <span className="muted" style={{ fontSize: 13 }}>datanet catalog still loading — try again in a moment</span>
              ) : (
                <span className="warn-note">every active datanet is already configured</span>
              )}
            </label>
          </div>

          <div className="field">
            <span>actions</span>
            <div className="row">
              <span role="button" tabIndex={0} aria-pressed={vote} className={`chip-toggle vote ${vote ? 'on' : ''}`}
                onClick={() => setVote((v) => !v)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setVote((v) => !v) } }}>vote</span>
              <span role="button" tabIndex={0} aria-pressed={mint} className={`chip-toggle mint ${mint ? 'on' : ''}`}
                onClick={() => setMint((v) => !v)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMint((v) => !v) } }}>mint</span>
            </div>
          </div>

          <label className="field">
            <span>adapter {mint && !adapter ? '(required to mint)' : ''}</span>
            <select value={adapter} onChange={(e) => setAdapter(e.target.value)}>
              {ADAPTERS.map((a) => <option key={a} value={a}>{a || 'none (vote-only)'}</option>)}
            </select>
          </label>

          <label className="field">
            <span>strictness <Tip label="what strictness means">{strictnessTip()}</Tip></span>
            <select value={strictness} onChange={(e) => setStrictness(e.target.value as DatanetEntry['strictness'])}>
              {STRICT.map((x) => <option key={x} value={x}>{STRICT_LABEL[x]}</option>)}
            </select>
          </label>

          <label className="field">
            <span>vote share <Tip label="what vote share means">Relative weight for splitting this cycle's vote slots across datanets. 3 vs 1 means this datanet gets 3× the votes of a weight-1 one. Default 1 (equal share). Whole numbers only; divides the per-cycle vote cap, does not raise it.</Tip></span>
            <input type="text" inputMode="numeric" value={voteShare} placeholder="1"
              onChange={(e) => setVoteShare(e.target.value)} />
          </label>

          <label className="field">
            <span>vote model <Tip label="what vote model does">Which LLM scores votes for THIS datanet. Blank = the node's default model. Only providers whose API key is set on the node appear here. Pick a Gemini (google) model if this datanet's pods are videos.</Tip></span>
            <select value={modelProvider} onChange={(e) => selectProvider(e.target.value)}>
              <option value="">node default</option>
              {providers.map((p) => <option key={p.provider} value={p.provider}>{p.provider}</option>)}
            </select>
          </label>

          {modelProvider && (
            <label className="field">
              <span>model slug <Tip label="what model slug does">The provider's model id (slugs drift, so free text is allowed). Suggestions come from the node; type any valid slug for {modelProvider}.</Tip></span>
              <input type="text" list="add-models" value={modelSlug} placeholder={curModels[0] ?? 'model id'}
                onChange={(e) => setModelSlug(e.target.value)} />
              <datalist id="add-models">
                {curModels.map((m) => <option key={m} value={m} />)}
              </datalist>
            </label>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!canAdd} onClick={submit}>Add datanet</button>
        </div>
      </div>
    </div>
  )
}
