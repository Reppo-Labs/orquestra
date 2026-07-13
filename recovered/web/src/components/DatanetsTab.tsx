import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  loadModels, runNow,
  type ActivityRow, type DatanetEntry, type DatanetPnl, type DatanetYield, type HealthDatanet,
  type ModelProvider, type Pnl, type Snapshot,
} from '../api'
import type { Strategy } from '../lib/useStrategy'
import { fmtCount, fmtEth, fmtPct, fmtReppo } from '../lib/format'
import {
  actionPlan, applyDisable, emissionsStarted, lossView, pendingByDatanet, recoveredDatanets,
  voteSharePct, workState, type WorkState,
} from '../lib/datanetStatus'
import { buildMintEstimate } from '../lib/mintEstimate'
import { PRESETS, strictnessTip } from '../lib/strictness'
import { AddDatanetModal } from './AddDatanetModal'
import { EconChips } from './EconChips'
import { MintEstimate } from './MintEstimate'
import { NodeSettings } from './NodeSettings'
import { Num, SaveBar } from './fields'
import { Tip } from './Tip'

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

type Params = { focus?: string; angle?: string; topN?: number; minImportance?: number }

/** Operational state, in the operator's words. Amber for "needs you", neutral otherwise —
 *  never green: green means profit, and a working datanet is not a profitable one. */
const STATE_LABEL: Record<WorkState, string> = {
  working: 'working',
  blocked: 'needs you',
  capped: 'at your cap',
  quiet: 'nothing to do',
  off: 'switched off',
  unknown: 'no signal yet',
}

/** Sort key: money first. What is bleeding, then what is broken, then everything else —
 *  the operator's eye should land on the row that costs the most to ignore. */
function rank(id: string, isLosing: boolean, net: number, state?: WorkState): [number, number, number] {
  const bucket = isLosing ? 0 : state === 'blocked' ? 1 : state === 'capped' ? 2 : 3
  return [bucket, net, Number(id)]
}

/** The one-click disable, in words that match what it will actually do. */
const DISABLE_NOTE = {
  mint: 'Publishing off — voting keeps running and keeps earning. Applies next cycle.',
  all: 'Voting and publishing off — this datanet does nothing now. Applies next cycle.',
} as const

/** The per-datanet remedy. Every one of the backend's six suggestedAction values lands on
 *  exactly one control here — a broken datanet must never be a dead end. */
function Remedy({ id, plan, strategy, snapshot, entry, onOpenCaps }: {
  id: string
  plan: ReturnType<typeof actionPlan>
  strategy: Strategy
  snapshot: Snapshot | null
  /** The datanet's CURRENT config entry, so the button can refuse to claim an act it cannot
   *  perform (already off, or no longer in the strategy at all). */
  entry: DatanetEntry | undefined
  onOpenCaps: () => void
}) {
  const [explain, setExplain] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  if (plan.kind === 'none') return null // 'none' = nothing the operator can do from here

  // A disable that would change nothing is not a remedy, it is a button that lies. Say what
  // the state already is instead of persisting an identical config and reporting success.
  const scope = plan.scope ?? 'all'
  const wouldChange = !!entry && (entry.mint || (scope === 'all' && entry.vote))
  if (plan.kind === 'disable' && !wouldChange) {
    return (
      <div className="remedy">
        <span className="muted" style={{ fontSize: 12 }}>
          {entry ? 'already off — the node is not acting on this datanet' : 'no longer in your strategy'}
        </span>
      </div>
    )
  }

  const act = async () => {
    switch (plan.kind) {
      case 'disable': {
        // Enabling a datanet IS the consent to pay it, so withdrawing that consent must be
        // one click and must PERSIST — a dirty candidate the operator forgets to save would
        // keep spending.
        //
        // SCOPED. A mint-side fault (no adapter, no publisher spec) is fixed by turning
        // PUBLISHING off. Turning voting off too would destroy the only path that earns
        // without spending — and the message beside this button literally says "voting still
        // works".
        setBusy(true)
        setMsg('')
        try {
          const res = await strategy.editAndSave((c) => {
            const d = c.datanets[id]
            if (d) applyDisable(d, scope)
          })
          setMsg(res.ok ? DISABLE_NOTE[scope] : `not saved: ${res.error ?? 'the node refused the change'}`)
        } finally {
          setBusy(false)
        }
        return
      }
      case 'raise_budget':
        onOpenCaps()
        return
      case 'retry': {
        setBusy(true)
        try {
          const r = await runNow()
          setMsg(r.started ? 'cycle started' : (r.reason ?? r.error ?? 'could not start'))
        } finally {
          setBusy(false)
        }
        return
      }
      default:
        // explain_rpc / explain_model_quota / explain_funding — fixes that live in the .env or at
        // a third party. The dashboard holds no secrets and cannot perform them; it can only say
        // precisely what to do, and say which system is actually at fault.
        setExplain((e) => !e)
    }
  }

  const explainable = plan.kind === 'explain_rpc' || plan.kind === 'explain_model_quota' || plan.kind === 'explain_funding'
  const bal = snapshot?.balance
  return (
    <div className="remedy">
      <button className="btn ghost sm" disabled={busy}
        aria-expanded={explainable ? explain : undefined}
        onClick={() => void act()}>
        {busy ? 'working…' : plan.label}
      </button>
      {msg && <span className="muted" style={{ fontSize: 12 }} role="status">{msg}</span>}
      {explain && plan.kind === 'explain_rpc' && (
        <div className="remedy-note" role="status">
          The node reads Reppo through <span className="mono">RPC_URL</span> in its{' '}
          <span className="mono">.env</span> — the dashboard cannot change it, because the dashboard
          holds no secrets. Point it at a private endpoint (Alchemy, Infura, your own node) and
          restart the node. A public RPC gets rate-limited and datanets go quiet exactly like this.
        </div>
      )}
      {explain && plan.kind === 'explain_model_quota' && (
        <div className="remedy-note" role="status">
          This is your AI model provider — not your node, not your wallet, not Reppo. It stopped
          answering because the account's quota or credit ran out. Open the provider's billing or
          quota page and top it up, or wait for the daily quota to reset (a daily limit clears on
          its own). You can also point this datanet at a model on a provider that still has
          headroom, in <span className="mono">Settings → model</span>.
        </div>
      )}
      {explain && plan.kind === 'explain_funding' && (
        <div className="remedy-note" role="status">
          The node's wallet is short. Send REPPO (mint fees run ~100–200 each) or ETH (gas) to the
          wallet whose key is in the node's <span className="mono">.env</span> — no dashboard action
          can create funds.
          {bal && (
            <div className="mono" style={{ marginTop: 6 }}>
              wallet now: {fmtReppo(bal.reppo)} · {fmtEth(bal.eth)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Relative weight, in plain words. A bare "7" means nothing on its own — what the operator
 *  actually gets is a SLICE of the cycle's votes, so we show the slice and let them nudge
 *  it. The stored config value is untouched (still an integer weight). */
function VoteWeight({ id, datanets, edit }: {
  id: string; datanets: Record<string, DatanetEntry>; edit: Strategy['edit']
}) {
  const entry = datanets[id]
  const pct = voteSharePct(id, datanets)
  if (!entry.vote) return <span className="faint" style={{ fontSize: 12 }}>not voting</span>
  const weight = Math.max(1, entry.voteShare ?? 1)
  const bump = (delta: number) => edit((c) => {
    const next = Math.min(20, Math.max(1, weight + delta))
    // 1 is the schema default (equal share) — store nothing rather than a redundant 1.
    if (next === 1) delete c.datanets[id].voteShare
    else c.datanets[id].voteShare = next
  })
  return (
    <div className="weight" role="group" aria-label={`vote priority for datanet ${id}`}>
      <button className="step" aria-label="lower vote priority" disabled={weight <= 1} onClick={() => bump(-1)}>−</button>
      <span className="weight-val">
        <b>{pct === null ? '—' : fmtPct(pct / 100)}</b>
        <span className="muted"> of votes</span>
      </span>
      <button className="step" aria-label="raise vote priority" disabled={weight >= 20} onClick={() => bump(1)}>+</button>
    </div>
  )
}

/** Everything a non-technical operator should never have to see to run a node: the data
 *  source, how the pod is attached, which LLM scores it, and the adapter's knobs. */
function AdvancedPanel({ id, d, edit, providers }: {
  id: string; d: DatanetEntry; edit: Strategy['edit']; providers: ModelProvider[]
}) {
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
  // Set the slug verbatim — an empty string is a valid mid-edit state and must NOT snap back
  // to models[0]. The node falls back to its default slug for an empty override.
  const setModel = (provider: string, model: string) =>
    upd((n) => {
      if (!provider) delete n.model
      else n.model = { provider, model }
    })
  const selectProvider = (provider: string) =>
    setModel(provider, provider ? (providers.find((x) => x.provider === provider)?.models[0] ?? '') : '')
  const curProvider = d.model?.provider ?? ''
  const curModels = providers.find((x) => x.provider === curProvider)?.models ?? []

  return (
    <div className="dn-advanced" id={`adv-${id}`}>
      <div className="net-row">
        <label className="field">
          <span>adapter <Tip label="what the adapter does">Where mint candidates come from for this datanet: gdelt = world news, hyperliquid = on-chain trades, sports = sports signals. Blank = no minting source (vote-only).</Tip></span>
          <select value={d.adapter ?? ''} aria-label={`adapter for datanet ${id}`}
            onChange={(e) => upd((n) => { if (e.target.value) n.adapter = e.target.value; else delete n.adapter })}>
            {ADAPTERS.map((a) => <option key={a} value={a}>{a || '—'}</option>)}
          </select>
        </label>
        <label className="field">
          <span>mint mode <Tip label="what mint mode means">{mintModeTip}</Tip></span>
          <select value={d.mintMode ?? 'pin'} aria-label={`mint mode for datanet ${id}`}
            onChange={(e) => upd((n) => { n.mintMode = e.target.value as DatanetEntry['mintMode'] })}>
            <option value="pin">pin dataset to IPFS (needs Pinata)</option>
            <option value="url-only">url-only (no Pinata)</option>
          </select>
        </label>
        <label className="field">
          <span>vote model <Tip label="what vote model does">Which LLM scores votes for THIS datanet. Blank = the node's default model. Only providers whose API key is set on the node appear here (keys are never entered in the dashboard). Pick a Gemini (google) model if this datanet's pods are videos.</Tip></span>
          <select value={curProvider} aria-label={`vote model provider for datanet ${id}`} onChange={(e) => selectProvider(e.target.value)}>
            <option value="">node default</option>
            {providers.map((x) => <option key={x.provider} value={x.provider}>{x.provider}</option>)}
            {/* A persisted override whose provider has no key on the node is NOT in `providers`.
                Surface it so the select shows the real saved value instead of silently snapping to
                "node default" — a plain Save would otherwise re-persist the dead override. */}
            {curProvider && !providers.some((x) => x.provider === curProvider) && (
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
      <div className="net-row">
        <label className="field">
          <span>focus <Tip label="what focus does">Free-text steer for the adapter — regions, topics, or keywords to prioritize when pulling mint candidates (e.g. "energy markets, Middle East").</Tip></span>
          <input type="text" placeholder="regions / topics / keywords" value={p.focus ?? ''} onChange={(e) => setParam('focus', e.target.value)} />
        </label>
        <label className="field">
          <span>angle <Tip label="what angle does">Editorial stance passed into scoring for this datanet — e.g. "contrarian", "risk-focused". Shapes how candidates are judged, not which are fetched.</Tip></span>
          <input type="text" placeholder="stance — e.g. contrarian, risk-focused" value={p.angle ?? ''} onChange={(e) => setParam('angle', e.target.value)} />
        </label>
        <Num label="items / cycle" int value={p.topN} onChange={(n) => setParam('topN', n)}
          hint="Max candidate items this adapter pulls per cycle before scoring. Higher = more coverage but more LLM scoring calls." />
        <Num label="min importance" int value={p.minImportance} onChange={(n) => setParam('minImportance', n)}
          hint="Adapter pre-filter: drop candidates scoring below this importance before the node spends LLM calls scoring them. Higher = stricter, fewer candidates." />
      </div>
      <div className="dn-advanced-foot">
        <button className="link-btn" onClick={() => edit((c) => { delete c.datanets[id] })}>remove this datanet</button>
      </div>
    </div>
  )
}

function DatanetRow({ id, name, d, strategy, providers, health, pnl, allPnl, econ, maxYield, snapshot, recovered, loss, onOpenCaps, rowRef, flash }: {
  id: string
  name: string
  d: DatanetEntry
  strategy: Strategy
  providers: ModelProvider[]
  health?: HealthDatanet
  pnl?: DatanetPnl
  /** Every datanet's P&L — the estimate needs the spread of fees this node has paid ELSEWHERE
   *  when this datanet has never charged it. */
  allPnl: DatanetPnl[]
  econ?: DatanetYield
  maxYield: number
  snapshot: Snapshot | null
  /** This datanet has worked SINCE its last failure — the classification is history. */
  recovered: boolean
  /** Losing-money verdict, with the emissions it is already owed credited (lossView). */
  loss: { losing: boolean; pending: number }
  onOpenCaps: () => void
  /** Registers the row's element so a click-through from the yield leaderboard can scroll to it. */
  rowRef?: (el: HTMLDivElement | null) => void
  /** This row is the one the operator just clicked through to — highlight it once. */
  flash?: boolean
}) {
  const [open, setOpen] = useState(false)
  // Turning mint ON is a spending decision, so it goes through the estimate first. Turning it
  // OFF is free and immediate — never make an operator confirm their way OUT of paying.
  const [confirmMint, setConfirmMint] = useState(false)
  const { edit, candidate } = strategy
  const off = !d.vote && !d.mint
  // "off" is a state of its own: a datanet the operator switched off is not blocked and not
  // broken, and its week-old skip rows must not keep saying "needs you".
  const state: WorkState = off ? 'off' : workState(health, recovered)
  const plan = actionPlan(health?.classification, health)
  const upd = (fn: (n: DatanetEntry) => void) => edit((c) => fn(c.datanets[id]))

  const toggleMint = () => {
    if (d.mint) { upd((n) => { n.mint = false }); setConfirmMint(false); return }
    setConfirmMint((c) => !c) // show the price BEFORE the consent
  }
  const confirmMintOn = () => {
    upd((n) => { n.mint = true })
    setConfirmMint(false)
  }

  return (
    // tabIndex -1: programmatically focusable (a click-through lands the operator here and
    // the row's accessible name is announced), but NEVER in the tab order — arriving on the
    // Datanets tab must not push a keyboard user through one stop per datanet.
    <div ref={rowRef} tabIndex={-1} aria-label={`datanet ${id}${name ? ` — ${name}` : ''}`}
      className={`dn-row ${off ? 'off' : ''} ${loss.losing ? 'losing' : ''} ${flash ? 'flash' : ''}`}>
      <div className="dn-main">
        <div className="dn-id">
          <div className="dn-name">{name || `datanet ${id}`}</div>
          <div className="dn-sub mono">datanet {id}{off ? ' · off' : ''}</div>
        </div>

        {/* IS IT EARNING — the only place green/red are allowed on this screen. */}
        <div className="dn-cell">
          <div className="dn-label">Earning</div>
          {pnl ? (
            <>
              <div className={`dn-val mono ${pnl.net > 0 ? 'pos' : pnl.net < 0 ? 'neg' : ''}`}>
                {pnl.net > 0 ? '+' : ''}{fmtReppo(pnl.net)}
              </div>
              <div className="dn-sub">
                {/* roi null = nothing spent. "—", NEVER "0%": a 0-spend datanet has no return ratio. */}
                return {pnl.roi === null ? '—' : fmtPct(pnl.roi / 100)}
                {' · '}{fmtCount(pnl.votesCast)} votes · {fmtCount(pnl.mintsExecuted)} mints
                {/* Owed, not held: emissions lag by about an epoch, so this is stated beside the
                    realized figure and never added into it. */}
                {loss.pending > 0 && <> · <span className="faint">{fmtReppo(loss.pending)} due</span></>}
              </div>
            </>
          ) : <div className="dn-val faint">—</div>}
        </div>

        <div className="dn-cell">
          <div className="dn-label">Working</div>
          <span className={`pill ${state === 'blocked' || state === 'capped' ? 'idle' : 'active'}`}>{STATE_LABEL[state]}</span>
        </div>

        <div className="dn-cell">
          <div className="dn-label">Pays</div>
          <EconChips y={econ} maxYield={maxYield} />
        </div>
      </div>

      {/* Plain English, redacted server-side. The raw stderr this replaces never reaches the UI. */}
      {health?.classification && (state === 'blocked' || state === 'capped') && (
        <div className="dn-alert">
          <span className="dn-alert-msg">{health.classification.operatorMessage}</span>
          <Remedy id={id} plan={plan} strategy={strategy} snapshot={snapshot}
            entry={candidate?.datanets[id]} onOpenCaps={onOpenCaps} />
        </div>
      )}

      {/* THE decisions: what it does, and how picky it is. Everything else is Advanced. */}
      <div className="dn-controls">
        <div className="dn-acts">
          <Tip label="vote vs mint">vote = cast up/down votes on OTHER people's pods in this datanet (earns voter emissions). mint = publish your OWN pods here (costs a REPPO fee; earns pod-owner emissions if upvoted).</Tip>
          <span role="button" tabIndex={0} aria-pressed={d.vote} aria-label={`vote on datanet ${id}`}
            className={`chip-toggle vote ${d.vote ? 'on' : ''}`}
            onClick={() => upd((n) => { n.vote = !n.vote })}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); upd((n) => { n.vote = !n.vote }) } }}>vote</span>
          <span role="button" tabIndex={0} aria-pressed={d.mint} aria-label={`mint on datanet ${id}`}
            aria-expanded={!d.mint ? confirmMint : undefined}
            className={`chip-toggle mint ${d.mint ? 'on' : ''}`}
            onClick={toggleMint}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMint() } }}>mint</span>
        </div>

        {/* Presets, not a threshold dropdown: three named ways to be picky, each writing one of
            the three EXISTING strictness values. No new config value is introduced. */}
        <div className="seg" role="radiogroup" aria-label={`how picky on datanet ${id}`}>
          {PRESETS.map((p) => (
            <label key={p.value} title={p.blurb}>
              <input type="radio" name={`strict-${id}`} value={p.value} checked={d.strictness === p.value}
                onChange={() => upd((n) => { n.strictness = p.value })} />
              {p.name}
            </label>
          ))}
          <Tip label="what these presets mean">{strictnessTip()}</Tip>
        </div>

        {candidate && <VoteWeight id={id} datanets={candidate.datanets} edit={edit} />}

        <button className="link-btn dn-adv-btn" aria-expanded={open} aria-controls={`adv-${id}`} onClick={() => setOpen((o) => !o)}>
          {open ? '− Advanced' : '+ Advanced'}
        </button>
      </div>

      {/* The blank cheque, priced. Shown at the toggle, before the consent — not in a help
          page the operator will never open. */}
      {confirmMint && !d.mint && (
        <div className="dn-confirm">
          <MintEstimate est={buildMintEstimate({ datanetId: id, snapshot, datanetPnl: allPnl })} name={name} />
          <div className="dn-confirm-foot">
            <button className="btn ghost sm" onClick={() => setConfirmMint(false)}>Cancel</button>
            <button className="btn primary sm" onClick={confirmMintOn}>Turn minting on</button>
            <span className="muted" style={{ fontSize: 12 }}>Applies when you save; the node mints from the next cycle.</span>
          </div>
        </div>
      )}

      {open && <AdvancedPanel id={id} d={d} edit={edit} providers={providers} />}
    </div>
  )
}

/** ONE row per datanet: is it earning, is it working, what does it pay, and the single
 *  decision that changes any of that. Everything the old Strategy tab put on the default
 *  surface (adapter, mint mode, vote model, adapter params) is still here — behind
 *  Advanced, where a non-technical operator will not trip over it. Health and economics
 *  used to be separate tabs; a datanet is ONE thing, so it gets ONE row. */
export function DatanetsTab({ strategy, netNames, health, datanetPnl, snapshot, pnl, activity, capsSignal, focusDatanet, onFocusConsumed, onReconfigure }: {
  strategy: Strategy
  netNames: Record<string, string>
  health: HealthDatanet[]
  datanetPnl: DatanetPnl[]
  snapshot: Snapshot | null
  /** Node-wide P&L — needed only to answer "have ANY emissions reached this node yet?".
   *  Until they have, no datanet can honestly be called a loss-maker. */
  pnl: Pnl | null
  /** The activity window — the only evidence of whether a datanet's failure is CURRENT. */
  activity: ActivityRow[]
  /** Bumped by the "Raise spending caps" remedy from anywhere in the app (alerts, Home).
   *  The remedy must land the operator ON the caps, not merely on the tab holding them. */
  capsSignal?: number
  /** The datanet a yield-leaderboard row click asked for: scroll to it, flash it once, and
   *  hand it back (onFocusConsumed) so returning to this tab later does not re-scroll. */
  focusDatanet?: string | null
  onFocusConsumed?: () => void
  onReconfigure: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [flashed, setFlashed] = useState<string | null>(null)
  const capsRef = useRef<HTMLHeadingElement | null>(null)
  const rowEls = useRef(new Map<string, HTMLDivElement>())
  useEffect(() => { void loadModels().then((r) => setProviders(r.providers)) }, [])
  const { candidate } = strategy

  const healthById = useMemo(() => new Map(health.map((h) => [h.datanetId, h])), [health])
  const pnlById = useMemo(() => new Map(datanetPnl.map((p) => [p.datanetId, p])), [datanetPnl])
  const recovered = useMemo(() => recoveredDatanets(activity), [activity])
  const pending = useMemo(() => pendingByDatanet(snapshot), [snapshot])
  const started = emissionsStarted(pnl)
  // One definition of "losing", shared with Home: spend, still down AFTER the emissions it is
  // already owed are credited, and only once this node has been paid something somewhere.
  const lossOf = (id: string) => {
    const p = pnlById.get(id)
    return p ? lossView(p, pending[id] ?? 0, started) : { losing: false, effectiveNet: 0, pending: pending[id] ?? 0 }
  }
  const economics = useMemo(() => snapshot?.datanetEconomics ?? [], [snapshot])
  const econById = useMemo(() => new Map(economics.map((y) => [y.datanetId, y])), [economics])
  const maxYield = Math.max(0, ...economics.map((y) => y.yieldPerVote ?? 0))

  // The raise_budget remedy: open the settings disclosure and put the operator ON the caps.
  const openCaps = useCallback(() => {
    setSettingsOpen(true)
    setTimeout(() => {
      capsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      capsRef.current?.focus()
    }, 0)
  }, [])

  // The same remedy, arriving from another tab (an alert's "Raise spending caps").
  useEffect(() => {
    if (capsSignal) openCaps()
  }, [capsSignal, openCaps])

  // The click-through from Home's yield leaderboard: same shape as openCaps — scroll the row
  // into view and put the operator ON it (tabIndex -1, so focus() announces the row without
  // adding a tab stop), then flash it so it is obvious WHICH row they landed on. The focus is
  // consumed immediately: it is a one-shot navigation intent, not tab state.
  useEffect(() => {
    // No candidate yet = no rows to land on. HOLD the intent (do not consume it) until the
    // strategy loads, or a click-through during the first poll would silently do nothing.
    if (!focusDatanet || !candidate) return
    const el = rowEls.current.get(focusDatanet)
    onFocusConsumed?.()
    if (!el) return // the leaderboard ranks configured datanets, but never assume the row exists
    setFlashed(focusDatanet)
    // An operator who asked for less motion gets the jump, not the glide (the flash itself is
    // reduced to a static outline in CSS).
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    el.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
    el.focus({ preventScroll: true })
    const t = setTimeout(() => setFlashed(null), 1600) // matches the CSS animation
    return () => clearTimeout(t)
  }, [focusDatanet, onFocusConsumed, candidate])

  if (!candidate) return <div className="muted">loading strategy…</div>

  const rankOf = (id: string, d: DatanetEntry): [number, number, number] => {
    const l = lossOf(id)
    const state: WorkState = !d.vote && !d.mint ? 'off' : workState(healthById.get(id), recovered.has(id))
    return rank(id, l.losing, l.effectiveNet, state)
  }
  const rows = Object.entries(candidate.datanets)
    .filter(([id]) => id !== '*')
    .sort(([a, da], [b, db]) => {
      const ra = rankOf(a, da)
      const rb = rankOf(b, db)
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]
    })

  return (
    <div key="datanets">
      <div className="sec-head">
        <h2>Datanets</h2><div className="rule" />
        <button className="btn ghost sm" onClick={() => setAdding(true)}>+ add datanet</button>
        <button className="btn ghost sm" onClick={onReconfigure}>↻ reconfigure with assistant</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        Sorted by what costs you most to ignore: money-losing first, then anything that can't run.
        Changes apply from the next cycle.
      </div>

      <div className="dn-list">
        {rows.map(([id, d]) => (
          <DatanetRow
            key={id} id={id} d={d} name={netNames[id] ?? ''} strategy={strategy} providers={providers}
            health={healthById.get(id)} pnl={pnlById.get(id)} allPnl={datanetPnl}
            econ={econById.get(id)} maxYield={maxYield}
            snapshot={snapshot} recovered={recovered.has(id)} loss={lossOf(id)} onOpenCaps={openCaps}
            flash={flashed === id}
            rowRef={(el) => { if (el) rowEls.current.set(id, el); else rowEls.current.delete(id) }}
          />
        ))}
      </div>

      <NodeSettings
        strategy={strategy} providers={providers}
        open={settingsOpen} onToggle={() => setSettingsOpen((o) => !o)} capsRef={capsRef}
      />

      <SaveBar strategy={strategy} />

      {adding && (
        <AddDatanetModal
          existing={rows.map(([id]) => id)}
          netNames={netNames}
          providers={providers}
          snapshot={snapshot}
          datanetPnl={datanetPnl}
          onAdd={(id, entry) => strategy.edit((c) => { c.datanets[id] = entry })}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  )
}
