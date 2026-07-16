import { useEffect, useState, type ReactNode } from 'react'
import { type DatanetEntry, type DatanetYield, loadModels, type ModelProvider, type AgentInfo, getAgent, renameAgent } from '../api'
import type { Strategy, Candidate } from '../lib/useStrategy'
import { netLabel } from '../lib/format'
import { AddDatanetModal } from './AddDatanetModal'
import { Tip } from './Tip'
import { STRICT, STRICT_LABEL, strictnessTip } from '../lib/strictness'

const ADAPTERS = ['', 'gdelt', 'hyperliquid', 'sports']

const mintModeTip = (
  <>
    <b>How the minted pod's data is attached.</b> <b>pin</b> uploads the dataset JSON
    to IPFS via your Pinata key — best when the dataset itself is the value (e.g.
    trade data). <b>url-only</b> registers the candidate's source link as the pod
    with no pinning and no Pinata — fine for link-type pods (e.g. news), and skips
    candidates that have no source URL.
  </>
)

function Num({ label, value, int, onChange, hint }: {
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

type Params = { focus?: string; angle?: string; topN?: number; minImportance?: number }

/** Read-only economics chip row for a datanet card — the decision-support data for the
 *  voteShare/vote controls right below it. Heat is RELATIVE to the best yield across
 *  the node's datanets this cycle (hot ≥ ⅔ of max, warm ≥ ⅓), not an absolute scale. */
function EconChips({ y, maxYield }: { y?: DatanetYield; maxYield: number }) {
  if (!y) return null // pre-feature snapshot, or the datanet didn't reach vote scoring yet
  const rate = y.emissionsPerEpochReppo > 0
    ? `${y.emissionsPerEpochReppo.toLocaleString()} REPPO/epoch`
    : y.nativeTokenSymbol ? `${y.nativeTokenSymbol} (native)` : 'pays nothing'
  const heat = y.yieldPerVote !== null && maxYield > 0
    ? y.yieldPerVote >= maxYield * (2 / 3) ? 'hot' : y.yieldPerVote >= maxYield / 3 ? 'warm' : ''
    : ''
  return (
    <div className="econ-chips">
      <span className={`econ-chip ${y.emissionsPerEpochReppo > 0 || y.nativeTokenSymbol ? '' : 'off'}`}>{rate}</span>
      {y.epochVoteVolume === null ? (
        <span className="econ-chip off" title={y.unavailableReason ? `volume read failed: ${y.unavailableReason}` : 'no RPC configured on this node'}>
          yield unavailable{y.unavailableReason ? ' (read failed)' : ''}
        </span>
      ) : y.uncontested ? (
        <span className="econ-badge uncontested" title={`nobody has voted in epoch ${y.epoch} yet — the first voter takes the epoch's emissions`}>
          uncontested · epoch {y.epoch}
        </span>
      ) : y.yieldPerVote !== null ? (
        <span className={`econ-chip yield ${heat}`} title={`epoch ${y.epoch} vote volume ${y.epochVoteVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}>
          ⚡ {y.yieldPerVote.toExponential(2)}/vote
        </span>
      ) : null /* rate 0 (native/pays-nothing): the rate chip already says it — no dead "⚡ —" chip */}
    </div>
  )
}

function NetCard({ id, d, name, edit, providers, econ, maxYield, flash }: {
  id: string; d: DatanetEntry; name: string; edit: Strategy['edit']; providers: ModelProvider[]
  econ?: DatanetYield; maxYield: number
  /** one-shot highlight after a leaderboard click-through scrolled here */
  flash?: boolean
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
  // Set the slug verbatim — an empty string is a valid mid-edit state and must NOT snap
  // back to models[0] (that jumped the input back to e.g. gemini-3-pro on clear). The
  // node falls back to its default slug for an empty override at resolve time.
  const setModel = (provider: string, model: string) =>
    upd((n) => {
      if (!provider) delete n.model
      // the <select> only offers LlmProvider values; the DOM hands them back as string
      else n.model = { provider, model } as DatanetEntry['model']
    })
  // Provider (re)selection: auto-fill a sensible default slug for the new provider. This is
  // the ONLY place models[0] is substituted — slug keystrokes go through setModel untouched.
  const selectProvider = (provider: string) =>
    setModel(provider, provider ? (providers.find((p) => p.provider === provider)?.models[0] ?? '') : '')
  const curProvider = d.model?.provider ?? ''
  const curModels = providers.find((p) => p.provider === curProvider)?.models ?? []

  return (
    <div id={`net-card-${id}`} className={`net ${d.mint ? 'active-mint' : ''} ${flash ? 'flash' : ''}`}>
      <div className="net-top">
        <div>
          <div className="net-id mono">datanet {id}</div>
          <div className="net-name">{name || '—'}</div>
        </div>
        <div className="net-acts">
          <Tip label="vote vs mint">vote = cast up/down votes on OTHER people's pods in this datanet (earns voter emissions). mint = publish your OWN pods here (costs a REPPO fee; earns pod-owner emissions if upvoted).</Tip>
          <span role="button" tabIndex={0} aria-pressed={d.vote} className={`chip-toggle vote ${d.vote ? 'on' : ''}`}
            onClick={() => upd((n) => { n.vote = !n.vote })}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); upd((n) => { n.vote = !n.vote }) } }}>vote</span>
          <span role="button" tabIndex={0} aria-pressed={d.mint} className={`chip-toggle mint ${d.mint ? 'on' : ''}`}
            onClick={() => upd((n) => { n.mint = !n.mint })}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); upd((n) => { n.mint = !n.mint }) } }}>mint</span>
        </div>
      </div>
      <EconChips y={econ} maxYield={maxYield} />
      <div className="net-row">
        <label className="field">
          <span>adapter <Tip label="what the adapter does">Where mint candidates come from for this datanet: gdelt = world news, hyperliquid = on-chain trades, sports = sports signals. Blank = no minting source (vote-only).</Tip></span>
          <select value={d.adapter ?? ''} onChange={(e) => upd((n) => { if (e.target.value) n.adapter = e.target.value; else delete n.adapter })}>
            {ADAPTERS.map((a) => <option key={a} value={a}>{a || '—'}</option>)}
          </select>
        </label>
        <label className="field">
          <span>strictness <Tip label="what strictness means">{strictnessTip()}</Tip></span>
          <select value={d.strictness} onChange={(e) => upd((n) => { n.strictness = e.target.value as DatanetEntry['strictness'] })}>
            {STRICT.map((x) => <option key={x} value={x}>{STRICT_LABEL[x]}</option>)}
          </select>
        </label>
        <Num label="vote share" int value={d.voteShare} onChange={(n) => upd((m) => {
          // Only a positive integer is a valid weight (schema is .int().positive()). Blank, 0,
          // or negative ⇒ unset, which the node reads as the default 1 (equal share). This keeps
          // a stray "0" from 400-ing the whole config save.
          if (n === undefined || n < 1) delete m.voteShare; else m.voteShare = n
        })}
          hint="Relative weight for splitting this cycle's vote slots across datanets. 3 vs 1 means this datanet gets 3× the votes of a weight-1 one. Blank = 1 (equal share). Whole numbers only; divides the per-cycle vote cap, does not raise it." />
      </div>
      <div className="net-row">
        <label className="field">
          <span>vote model <Tip label="what vote model does">Which LLM scores votes for THIS datanet. Blank = the node's default model. Only providers whose API key is set on the node appear here (keys are never entered in the dashboard). Pick a Gemini (google) model if this datanet's pods are videos.</Tip></span>
          <select value={curProvider} onChange={(e) => selectProvider(e.target.value)}>
            <option value="">node default</option>
            {providers.map((p) => <option key={p.provider} value={p.provider}>{p.provider}</option>)}
            {/* A persisted override whose provider has no key on the node (key removed from
                env) is NOT in `providers`. Surface it as a selected option so the select shows
                the real saved value instead of silently snapping to "node default" — a plain
                Save would otherwise re-persist the dead override and skip votes silently. */}
            {curProvider && !providers.some((p) => p.provider === curProvider) && (
              <option value={curProvider}>{curProvider} (no key configured)</option>
            )}
          </select>
        </label>
        {curProvider && (
          <label className="field">
            <span>model slug <Tip label="what model slug does">The provider's model id (slugs drift, so free text is allowed). Suggestions come from the node; type any valid slug for {curProvider}.</Tip></span>
            <input type="text" list={`models-${id}`} value={d.model?.model ?? ''} placeholder={curModels[0] ?? 'model id'}
              onChange={(e) => setModel(curProvider, e.target.value)} />
            <datalist id={`models-${id}`}>
              {curModels.map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>
        )}
      </div>
      <div className={`net-strategy ${open ? '' : 'collapsed'}`}>
        <label className="field">
          <span>focus <Tip label="what focus does">Free-text steer for the adapter — regions, topics, or keywords to prioritize when pulling mint candidates (e.g. "energy markets, Middle East").</Tip></span>
          <input type="text" placeholder="regions / topics / keywords" value={p.focus ?? ''} onChange={(e) => setParam('focus', e.target.value)} />
        </label>
        <label className="field">
          <span>angle <Tip label="what angle does">Editorial stance passed into scoring for this datanet — e.g. "contrarian", "risk-focused". Shapes how candidates are judged, not which are fetched.</Tip></span>
          <input type="text" placeholder="stance — e.g. contrarian, risk-focused" value={p.angle ?? ''} onChange={(e) => setParam('angle', e.target.value)} />
        </label>
        <div className="net-row">
          <Num label="items / cycle" int value={p.topN} onChange={(n) => setParam('topN', n)}
            hint="Max candidate items this adapter pulls per cycle before scoring. Higher = more coverage but more LLM scoring calls." />
          <Num label="min importance" int value={p.minImportance} onChange={(n) => setParam('minImportance', n)}
            hint="Adapter pre-filter: drop candidates scoring below this importance before the node spends LLM calls scoring them. Higher = stricter, fewer candidates." />
        </div>
        <label className="field">
          <span>mint mode <Tip label="what mint mode means">{mintModeTip}</Tip></span>
          <select value={d.mintMode ?? 'pin'} onChange={(e) => upd((n) => { n.mintMode = e.target.value as DatanetEntry['mintMode'] })}>
            <option value="pin">pin dataset to IPFS (needs Pinata)</option>
            <option value="url-only">url-only (no Pinata)</option>
          </select>
        </label>
      </div>
      <div className="net-foot">
        <button className="link-btn" onClick={() => setOpen((o) => !o)}>{open ? '− hide strategy' : '+ mint strategy'}</button>
        <button className="link-btn" onClick={() => edit((c) => { delete c.datanets[id] })}>remove</button>
      </div>
    </div>
  )
}

/** Node-level default model picker — mirrors the per-datanet picker (NetCard), but writes
 *  the top-level `candidate.defaultModel`. Used wherever a datanet has no override AND by the
 *  assistant chat. Empty provider ("node default (env)") deletes the field → the env default. */
function DefaultModelPicker({ candidate, edit, providers }: {
  candidate: Candidate; edit: Strategy['edit']; providers: ModelProvider[]
}) {
  // A blank slug is NOT a valid persisted default: StrategyConfigSchema requires
  // defaultModel.model to be min(1), so writing { provider, model: '' } would 400 the
  // ENTIRE config save (losing other edits). Treat an empty/whitespace slug as UNSET —
  // delete the field, exactly like the empty "node default (env)" provider option does.
  // The operator must type a free-text slug for a provider default to take effect.
  const setModel = (provider: string, model: string) =>
    edit((c) => {
      if (!provider || model.trim() === '') delete c.defaultModel
      // the <select> only offers LlmProvider values; the DOM hands them back as string
      else c.defaultModel = { provider, model } as Candidate['defaultModel']
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
        <select value={curProvider} onChange={(e) => selectProvider(e.target.value)}>
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

/** Platform agent identity: shows the registered agent + lets the operator rename it.
 *  The rename PATCHes the Reppo platform immediately (POST /api/agent/name) — it is
 *  NOT part of the strategy candidate, so no SaveBar involvement. */
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
      <div className="sec-head"><h2>Agent identity</h2><div className="rule" /></div>
      <div className="settings">
        {/* Name first — it's the label the Reppo platform displays; the immutable
            agent id is metadata, small + copyable underneath. */}
        <div className="agent-row">
          <input
            type="text" value={name} maxLength={64} disabled={busy || !agent.renameable}
            placeholder="display name on the Reppo platform"
            onChange={(e) => { setName(e.target.value); setMsg('') }}
            onKeyDown={(e) => { if (e.key === 'Enter' && dirty) void save() }}
          />
          <button className="btn primary sm" disabled={!dirty || busy || !agent.renameable} onClick={() => void save()}>
            {busy ? 'renaming…' : 'Rename'}
          </button>
          <span className={`muted ${msg.includes('✓') ? 'pos' : msg ? 'neg' : ''}`}>{msg}</span>
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

export function StrategyTab({ strategy, netNames, economics, focusDatanet, onFocusConsumed, onReconfigure }: {
  strategy: Strategy; netNames: Record<string, string>; economics?: DatanetYield[]
  /** Datanet card to scroll to + flash on mount (Overview leaderboard click-through). */
  focusDatanet?: string | null
  onFocusConsumed?: () => void
  onReconfigure: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [providers, setProviders] = useState<ModelProvider[]>([])
  useEffect(() => { void loadModels().then((r) => setProviders(r.providers)) }, [])
  const { candidate, edit } = strategy
  if (!candidate) return <div className="muted">loading strategy…</div>

  const rows = Object.entries(candidate.datanets).filter(([id]) => id !== '*')
  // Latest-cycle economics per datanet, and the best yield across them — the chips'
  // heat scale is relative to the node's own datanets, not an absolute threshold.
  const econById = new Map((economics ?? []).map((y) => [y.datanetId, y]))
  const maxYield = Math.max(0, ...(economics ?? []).map((y) => y.yieldPerVote ?? 0))
  // Leaderboard click-through: scroll the target card into view and flash it once.
  const [flashId, setFlashId] = useState<string | null>(null)
  useEffect(() => {
    if (!focusDatanet) return
    setFlashId(focusDatanet)
    // rAF: the card must be in the DOM before scrollIntoView (tab just mounted).
    requestAnimationFrame(() => {
      document.getElementById(`net-card-${focusDatanet}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    const t = setTimeout(() => { setFlashId(null); onFocusConsumed?.() }, 1800)
    return () => clearTimeout(t)
  }, [focusDatanet, onFocusConsumed])
  const budget = candidate.budget ?? {}
  const stake = candidate.stake ?? {}
  const delib = candidate.deliberation ?? {}
  const setB = (k: string, n: number | undefined) => edit((c) => {
    const b = { ...c.budget } as Record<string, number | undefined>
    b[k] = n
    c.budget = b as Candidate['budget']
  })

  return (
    <div>
      <AgentIdentity />

      <div className="sec-head"><h2>Node default model</h2><div className="rule" /></div>
      <div className="settings">
        <DefaultModelPicker candidate={candidate} edit={edit} providers={providers} />
      </div>

      <div className="sec-head">
        <h2>Datanets</h2><div className="rule" />
        <button className="btn ghost sm" onClick={onReconfigure}>↻ reconfigure with assistant</button>
      </div>
      <div className="net-grid stagger">
        {rows.map(([id, d]) => (
          <NetCard key={id} id={id} d={d} name={netNames[id] ?? netLabel(id, netNames)} edit={edit} providers={providers}
            econ={econById.get(id)} maxYield={maxYield} flash={flashId === id} />
        ))}
        <button className="net add" onClick={() => setAdding(true)}>
          <div style={{ textAlign: 'center' }}><div className="plus">+</div><div>add datanet</div></div>
        </button>
      </div>

      <div className="sec-head"><h2>Budget &amp; cadence</h2><div className="rule" /></div>
      <div className="settings">
        {/* Keep labels to ONE line (the 0.5 = 30m example lives in the hint):
            a wrapped label pushes its input out of row alignment in the grid. */}
        <Num label="cadence (hours)" value={candidate.cadenceHours} onChange={(n) => n !== undefined && edit((c) => { c.cadenceHours = n })}
          hint="How often the node runs a full cycle (vote → mint → claim). 0.5 = every 30 min, 6 = every 6h. Lower is more responsive but spends more on LLM calls and gas." />
        <Num label="horizon (days)" int value={candidate.horizonDays} onChange={(n) => n !== undefined && edit((c) => { c.horizonDays = n })}
          hint="Budget window, in days. The spend caps below (mint REPPO, gas) apply PER this window — the counters reset to 0 when it elapses, then a fresh window starts. e.g. 30 = a monthly budget." />
        <Num label="lock REPPO" value={stake.lockReppo} onChange={(n) => n !== undefined && edit((c) => { c.stake = { ...c.stake, lockReppo: n } })}
          hint="REPPO locked as veREPPO for voting power (a one-time lock at startup). More locked = more weight behind each vote. 0 = don't lock." />
        <Num label="lock days" int value={stake.lockDurationDays} onChange={(n) => n !== undefined && edit((c) => { c.stake = { ...c.stake, lockDurationDays: n } })}
          hint="How long the veREPPO lock holds before REPPO can be withdrawn. Longer locks generally grant more voting power." />
        <Num label="votes / cycle" int value={budget.voteRateMaxPerCycle} onChange={(n) => n !== undefined && setB('voteRateMaxPerCycle', n)}
          hint="Max votes the node casts in one cycle. Once hit, remaining candidates are deferred to the next cycle. Caps vote volume and gas." />
        <Num label="mint REPPO max" value={budget.mintReppoMax} onChange={(n) => n !== undefined && setB('mintReppoMax', n)}
          hint="Max REPPO spent on mint fees per horizon window. At the cap, further mints are refused before signing. (Mint fees run ~100–200 REPPO each.)" />
      </div>

      <div className="sec-head"><h2>Deliberation</h2><div className="rule" /></div>
      <div className="settings">
        <label className="field">
          <span>multi-agent panel <Tip label="what the panel is">When on, scores are decided by a panel — a bull, a bear, and a rubric-purist argue, then a judge rules — instead of one LLM call. Off = a single scorer for every vote and mint.</Tip></span>
          <div className="row">
            <label className="switch">
              <input type="checkbox" checked={delib.enabled !== false}
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
              <input type="checkbox" disabled={delib.enabled === false} checked={delib.enabled !== false && delib.votePanel !== false}
                onChange={(e) => edit((c) => { c.deliberation = { ...c.deliberation, votePanel: e.target.checked } })} />
              <span className="track" />
            </label>
            <span className="muted" style={{ fontSize: 12 }}>
              {delib.enabled === false ? 'panel off' : delib.votePanel !== false ? 'every vote deliberated by the panel' : 'votes use the single scorer (mints still use the panel)'}
            </span>
          </div>
        </label>
      </div>

      <div className="sec-head"><h2>Strategy brief</h2><div className="rule" /></div>
      <label className="notes-label">
        <span className="field-label">the goals the node votes and mints by — the panel judge applies this stance <Tip label="how the brief is used">Your strategy in plain language. It's injected as the operator stance into the judge (and single scorer) when scoring every vote and mint — e.g. "favor verifiable on-chain data, avoid hype." Leave blank to score purely by each datanet's rubric.</Tip></span>
        <textarea rows={4} value={candidate.notes ?? ''} onChange={(e) => edit((c) => { c.notes = e.target.value })} />
      </label>

      <SaveBar strategy={strategy} />

      {adding && (
        <AddDatanetModal
          existing={rows.map(([id]) => id)}
          netNames={netNames}
          providers={providers}
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
      <button className="btn primary" onClick={() => void save()}>Save changes</button>
      <span className="muted" style={{ fontSize: 12 }}>applies next cycle</span>
      <span className={`diff-line ${diff.length ? 'dirty' : ''}`}>
        {diff.length ? `${diff.length} unsaved change${diff.length > 1 ? 's' : ''}: ${diff.join(' · ')}` : 'no changes since last save'}
      </span>
      <div style={{ flex: 1 }} />
      {saveMsg && <span className="muted mono" style={{ fontSize: 12 }}>{saveMsg}</span>}
    </div>
  )
}
