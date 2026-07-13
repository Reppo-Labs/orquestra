import { useEffect, useState, type Ref, type RefObject } from 'react'
import { getAgent, renameAgent, type AgentInfo, type ModelProvider } from '../api'
import type { Candidate, Strategy } from '../lib/useStrategy'
import { Num } from './fields'
import { Tip } from './Tip'

// Everything node-WIDE that used to crowd the Strategy tab: the node's name, the default
// model, the spend caps and cadence, deliberation, and the strategy brief. None of it is
// per-datanet and none of it is a daily decision — so it sits behind one disclosure at the
// bottom of the Datanets tab instead of competing with the datanet rows for attention.
// Nothing was dropped: every field the old tab had is still here, saving through the same
// candidate and the same SaveBar.

/** Node-level default model picker. Writes the top-level `candidate.defaultModel`, used
 *  wherever a datanet has no override AND by the assistant chat. Empty provider deletes
 *  the field → the env default. */
function DefaultModelPicker({ candidate, edit, providers }: {
  candidate: Candidate; edit: Strategy['edit']; providers: ModelProvider[]
}) {
  // A blank slug is NOT a valid persisted default: StrategyConfigSchema requires
  // defaultModel.model to be min(1), so writing { provider, model: '' } would 400 the
  // ENTIRE config save (losing other edits). Treat an empty/whitespace slug as UNSET.
  const setModel = (provider: string, model: string) =>
    edit((c) => {
      if (!provider || model.trim() === '') delete c.defaultModel
      else c.defaultModel = { provider, model }
    })
  // Provider (re)selection auto-fills a sensible default slug — the only place models[0]
  // is substituted; slug keystrokes go through setModel untouched.
  const selectProvider = (provider: string) =>
    setModel(provider, provider ? (providers.find((p) => p.provider === provider)?.models[0] ?? '') : '')
  const curProvider = candidate.defaultModel?.provider ?? ''
  const curModels = providers.find((p) => p.provider === curProvider)?.models ?? []

  return (
    <div className="net-row">
      <label className="field">
        <span>provider <Tip label="what the node default model does">The LLM the node uses wherever a datanet has no per-datanet override, and for the assistant chat. Blank = the node's env default (LLM_PROVIDER). Only providers whose API key is set on the node appear here (keys are never entered in the dashboard). Changing it applies with no restart.</Tip></span>
        <select value={curProvider} aria-label="default model provider" onChange={(e) => selectProvider(e.target.value)}>
          <option value="">node default (env)</option>
          {providers.map((p) => <option key={p.provider} value={p.provider}>{p.provider}</option>)}
          {/* A persisted default whose provider has no key on the node (key removed from env)
              is NOT in `providers`. Surface it as a selected option so the select shows the real
              saved value instead of silently snapping to the env default. */}
          {curProvider && !providers.some((p) => p.provider === curProvider) && (
            <option value={curProvider}>{curProvider} (no key configured)</option>
          )}
        </select>
      </label>
      {curProvider && (
        <label className="field">
          <span>model slug <Tip label="what model slug does">The provider's model id (slugs drift, so free text is allowed). Suggestions come from the node; type any valid slug for {curProvider}.</Tip></span>
          <input type="text" list="default-models" value={candidate.defaultModel?.model ?? ''} placeholder={curModels[0] ?? 'model id'}
            onChange={(e) => setModel(curProvider, e.target.value)} />
          <datalist id="default-models">
            {curModels.map((m) => <option key={m} value={m} />)}
          </datalist>
        </label>
      )}
    </div>
  )
}

/** Platform agent identity: the registered agent + a rename. The rename PATCHes the Reppo
 *  platform immediately (POST /api/agent/name) — it is NOT part of the strategy candidate,
 *  so no SaveBar involvement. */
function AgentIdentity() {
  const [agent, setAgent] = useState<AgentInfo | null>(null)
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { void getAgent().then((a) => { setAgent(a); setName(a?.name ?? '') }) }, [])
  if (!agent) return null // voting-only node (no registration) — nothing to show
  const dirty = name.trim() !== (agent.name ?? '') && name.trim() !== ''
  const save = async () => {
    setBusy(true); setMsg('')
    const r = await renameAgent(name.trim())
    setBusy(false)
    if (!r.ok) { setMsg(r.error ?? 'rename failed'); return }
    setAgent({ ...agent, name: name.trim() }); setMsg('synced to the Reppo platform ✓')
  }
  return (
    <>
      <h3 className="settings-head">Node name</h3>
      <div className="settings">
        <div className="agent-row">
          <input
            type="text" value={name} maxLength={64} disabled={busy || !agent.renameable}
            placeholder="display name on the Reppo platform"
            aria-label="node display name"
            onChange={(e) => { setName(e.target.value); setMsg('') }}
            onKeyDown={(e) => { if (e.key === 'Enter' && dirty) void save() }}
          />
          <button className="btn primary sm" disabled={!dirty || busy || !agent.renameable} onClick={() => void save()}>
            {busy ? 'renaming…' : 'Rename'}
          </button>
          <span className={`muted ${msg.includes('✓') ? 'pos' : msg ? 'neg' : ''}`} role="status">{msg}</span>
        </div>
        <div className="agent-id">
          agent id: <span className="mono">{agent.agentId}</span>
          <button
            className="chip" title="copy agent id"
            onClick={() => { void navigator.clipboard.writeText(agent.agentId) }}
          >copy</button>
        </div>
        {!agent.renameable && (
          <div className="muted" style={{ marginTop: 6 }}>
            renaming needs the apiKey stored at registration — a manually-set REPPO_AGENT_ID can't authenticate the rename
          </div>
        )}
      </div>
    </>
  )
}

/** The node-wide half of the strategy. `open` is lifted so a datanet row's "Raise spending
 *  caps" remedy can expand this section and send the operator straight to the caps. */
export function NodeSettings({ strategy, providers, open, onToggle, capsRef }: {
  strategy: Strategy
  providers: ModelProvider[]
  open: boolean
  onToggle: () => void
  /** anchor the raise_budget remedy scrolls to and focuses */
  capsRef?: RefObject<HTMLHeadingElement | null>
}) {
  const { candidate, edit } = strategy
  if (!candidate) return null
  const budget = candidate.budget ?? {}
  const stake = candidate.stake ?? {}
  const delib = candidate.deliberation ?? {}
  const setB = (k: string, n: number | undefined) => edit((c) => {
    const b = { ...c.budget } as Record<string, number | undefined>
    b[k] = n
    c.budget = b as Candidate['budget']
  })

  return (
    <section className="node-settings">
      <button className="disclosure" aria-expanded={open} aria-controls="node-settings-body" onClick={onToggle}>
        <span className="disclosure-caret" aria-hidden="true">{open ? '−' : '+'}</span>
        Node settings
        <span className="muted"> — spending caps, cadence, model, deliberation, strategy brief</span>
      </button>
      {open && (
        <div id="node-settings-body" className="node-settings-body">
          <AgentIdentity />

          <h3 className="settings-head" ref={capsRef as Ref<HTMLHeadingElement>} tabIndex={-1} id="spending-caps">
            Spending caps &amp; cadence
          </h3>
          <div className="settings">
            <Num label="cadence (hours, e.g. 0.5 = 30m)" value={candidate.cadenceHours} onChange={(n) => n !== undefined && edit((c) => { c.cadenceHours = n })}
              hint="How often the node runs a full cycle (vote → mint → claim). 0.5 = every 30 min, 6 = every 6h. Lower is more responsive but spends more on LLM calls and gas." />
            <Num label="horizon (days)" int value={candidate.horizonDays} onChange={(n) => n !== undefined && edit((c) => { c.horizonDays = n })}
              hint="Budget window, in days. The spend caps below (mint REPPO, gas) apply PER this window — the counters reset to 0 when it elapses, then a fresh window starts. e.g. 30 = a monthly budget." />
            <Num label="votes / cycle" int value={budget.voteRateMaxPerCycle} onChange={(n) => n !== undefined && setB('voteRateMaxPerCycle', n)}
              hint="Max votes the node casts in one cycle. Once hit, remaining candidates are deferred to the next cycle. Caps vote volume and gas." />
            <Num label="mint REPPO max" value={budget.mintReppoMax} onChange={(n) => n !== undefined && setB('mintReppoMax', n)}
              hint="Max REPPO spent on mint fees per horizon window. At the cap, further mints are refused before signing. (Mint fees run ~100–200 REPPO each.)" />
            <Num label="lock REPPO" value={stake.lockReppo} onChange={(n) => n !== undefined && edit((c) => { c.stake = { ...c.stake, lockReppo: n } })}
              hint="REPPO locked as veREPPO for voting power (a one-time lock at startup). More locked = more weight behind each vote. 0 = don't lock." />
            <Num label="lock days" int value={stake.lockDurationDays} onChange={(n) => n !== undefined && edit((c) => { c.stake = { ...c.stake, lockDurationDays: n } })}
              hint="How long the veREPPO lock holds before REPPO can be withdrawn. Longer locks generally grant more voting power." />
          </div>

          <h3 className="settings-head">Default model</h3>
          <div className="settings">
            <DefaultModelPicker candidate={candidate} edit={edit} providers={providers} />
          </div>

          <h3 className="settings-head">Deliberation</h3>
          <div className="settings">
            <label className="field">
              <span>multi-agent panel <Tip label="what the panel is">When on, scores are decided by a panel — a bull, a bear, and a rubric-purist argue, then a judge rules — instead of one LLM call. Off = a single scorer for every vote and mint.</Tip></span>
              <div className="row">
                <label className="switch">
                  <input type="checkbox" aria-label="multi-agent panel" checked={delib.enabled !== false}
                    onChange={(e) => edit((c) => { c.deliberation = { ...c.deliberation, enabled: e.target.checked } })} />
                  <span className="track" />
                </label>
                <span className="muted" style={{ fontSize: 12 }}>{delib.enabled !== false ? 'bull · bear · rubric-purist + judge' : 'single scorer'}</span>
              </div>
            </label>
            <label className="field">
              <span>panel all votes <Tip label="what panel all votes means">On = EVERY vote goes through the panel (most thorough, ~4× the LLM calls per vote). Off = votes use the single scorer; mints still always use the panel. Needs the panel enabled.</Tip></span>
              <div className="row">
                <label className="switch">
                  <input type="checkbox" aria-label="panel all votes" disabled={delib.enabled === false} checked={delib.enabled !== false && delib.votePanel !== false}
                    onChange={(e) => edit((c) => { c.deliberation = { ...c.deliberation, votePanel: e.target.checked } })} />
                  <span className="track" />
                </label>
                <span className="muted" style={{ fontSize: 12 }}>
                  {delib.enabled === false ? 'panel off' : delib.votePanel !== false ? 'every vote deliberated by the panel' : 'votes use the single scorer (mints still use the panel)'}
                </span>
              </div>
            </label>
          </div>

          <h3 className="settings-head">Strategy brief</h3>
          <label className="notes-label">
            <span className="field-label">the goals the node votes and mints by — the panel judge applies this stance <Tip label="how the brief is used">Your strategy in plain language. It's injected as the operator stance into the judge (and single scorer) when scoring every vote and mint — e.g. "favor verifiable on-chain data, avoid hype." Leave blank to score purely by each datanet's rubric.</Tip></span>
            <textarea rows={4} value={candidate.notes ?? ''} onChange={(e) => edit((c) => { c.notes = e.target.value })} />
          </label>
        </div>
      )}
    </section>
  )
}
