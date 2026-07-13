// src/dashboard/routes.ts
// The dashboard JSON API as DATA: a route table of handlers, each a function
// (ctx, request) → { status, body } that is testable without an HTTP server.
// Transport concerns live in server.ts and are applied ONCE by its dispatcher,
// before any handler runs: the cross-site write guards (the panel is deliberately
// unauthenticated and localhost-bound, so CSRF/DNS-rebinding is the realistic
// remote path to the budget), JSON body parsing, and response serialization.
import { readActivity, readActivitySince, sumClaimedReppo, sumMintReppoSpent } from './activityLog.js'
import { readAgentStore, writeAgentStore, syncAgentName } from '../reppo/agent.js'
import { updateAgentOnPlatform } from '../reppo/platformApi.js'
import { readSnapshot } from './snapshot.js'
import { derivePnl } from './pnl.js'
import { readEarnStatus } from './earnStatus.js'
import { buildHealth } from './health.js'
import { StrategyConfigSchema, type StrategyConfig } from '../config/schema.js'
import { KNOWN_MODELS, type LlmProvider } from '../llm/model.js'
import { loadConfig, readConfigText, writeConfig, ConfigNotFoundError } from '../config/load.js'
import { buildLearnView } from '../learn/view.js'
import { readProposals, setProposalStatus, setLearnEnabled, clearLessons } from '../learn/store.js'
import { runStrategyChat, type ChatMessage } from './strategyChat.js'
import { queryLockConstraints, type LockConstraints } from '../reppo/queryLockConstraints.js'
import { listDatanetsJson } from '../reppo/listDatanets.js'
import { needsOnboarding, persistOnboarding } from '../onboarding/persist.js'
import { buildStrategyConfig } from '../onboarding/build.js'
import { validateAnswers } from '../onboarding/schema.js'
import { runOnboardingTurn, seedOnboardingMessages, type OnboardingTurnResult } from '../onboarding/agent.js'
import type { OnboardingAnswers } from '../onboarding/types.js'
import { getDatanetRubric } from '../rubric/load.js'
import { queryBalanceJson } from '../reppo/queryBalance.js'
import type { CoreMessage, LanguageModel } from 'ai'
import type {
  AgentInfo, AgentRenameResult, DatanetNames, EarnStatus, HealthReport, LearnView,
  ModelsResponse, OnboardingChatView, OnboardingStatusView, PnlResponse,
  ProposalDecisionView, RunNowResult, SafeStrategyConfig, SaveStrategyResult,
} from './apiTypes.js'

// ── route/dispatch types ────────────────────────────────────────────────────────

/** Options wired by index.ts when it starts the dashboard. */
export interface DashboardOpts {
  /** Resolve the current node-default chat model PER REQUEST (so a dashboard
   *  defaultModel change takes effect with no restart). Returns null when the
   *  effective default has no API key — handlers 503. */
  resolveChatModel?: () => LanguageModel | null
  /** Providers whose API key is present in env (the key registry's keys). The
   *  /api/models endpoint lists these — names only, NEVER keys. */
  availableProviders?: LlmProvider[]
  /** Override the built-SPA dir (defaults to `public/` beside server.ts); tests use this. */
  publicDir?: string
  /** Override the onboarding turn-runner (tests); defaults to the live model runner. */
  onboardingTurn?: (messages: CoreMessage[]) => Promise<OnboardingTurnResult>
  /** Trigger an off-schedule cycle NOW (the "run now" button). Resolved per request so
   *  it works even though the dashboard starts before the scheduler exists — index.ts wires
   *  a lazy closure. Absent (or returns { started:false }) before the scheduler is up. */
  triggerCycle?: () => { started: boolean; reason?: string }
}

/** One in-memory onboarding conversation per server (single-operator node).
 *  Lost on restart by design — restart simply restarts the interview. */
export interface OnboardingSession {
  messages: CoreMessage[]
  draft: Partial<OnboardingAnswers> | null
  finalized: OnboardingAnswers | null
}

/** Per-server state every handler may need; constructed once in startDashboard. */
export interface RouteContext {
  dataDir: string
  opts: DashboardOpts
  session: OnboardingSession
}

/** The parsed request a handler sees: transport already stripped away. */
export interface ApiRequest {
  /** URL path, query string removed. */
  url: string
  method: string
  /** Parsed JSON body — POST only ({} for an empty body). */
  body?: unknown
  /** Trailing segment for prefix routes (the `:id` of /api/learn/proposals/:id). */
  param?: string
}

export interface ApiResponse { status: number; body: unknown }

export type RouteHandler = (ctx: RouteContext, req: ApiRequest) => ApiResponse | Promise<ApiResponse>

export interface Route {
  method: 'GET' | 'POST'
  /** Exact path, or the prefix (ending in '/') when `prefix` is set. */
  path: string
  /** Prefix routes match `${path}${param}` — the remainder lands in ApiRequest.param. */
  prefix?: boolean
  handler: RouteHandler
}

/** Match method+url against the table: exact paths first, then prefix routes.
 *  Reads are matched under 'GET' whatever the wire method is (the dispatcher
 *  only distinguishes POST — writes — from everything else). */
export function matchRoute(table: Route[], method: 'GET' | 'POST', url: string): { route: Route; param?: string } | null {
  for (const route of table) {
    if (route.method !== method) continue
    if (route.prefix ? url.startsWith(route.path) : url === route.path) {
      return route.prefix ? { route, param: url.slice(route.path.length) } : { route }
    }
  }
  return null
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body })

// ── shared helpers (separate functions on purpose — they are seams of their own) ──

/** A safe subset of the strategy config — explicitly whitelisted fields only. */
export function safeConfig(dataDir: string): SafeStrategyConfig {
  const text = readConfigText(dataDir)
  if (text === null) return {}
  try {
    const c = JSON.parse(text) as Record<string, unknown>
    // Prefer the CANONICAL schema parse (defaults + transforms applied) so the
    // strategy editor always receives a complete, Save-able config — budget and
    // stake are NOT secrets (caps already surface via the snapshot).
    const parsed = StrategyConfigSchema.safeParse(c)
    if (parsed.success) {
      // nodeName included so the dashboard's save round-trip (GET → edit → POST full
      // candidate) doesn't silently drop the onboarding-chosen name from the config.
      const { horizonDays, cadenceHours, claimEmissions, datanets, notes, budget, stake, deliberation, defaultModel, nodeName } = parsed.data
      return { horizonDays, cadenceHours, claimEmissions, datanets, notes, budget, stake, deliberation, defaultModel, nodeName }
    }
    // tolerant fallback for a file the schema rejects (node likely won't run on it either).
    // deliberation falls back to the schema default so the editor reflects real behavior.
    // Best-effort raw echo — the cast is honest about that (values are unvalidated).
    return {
      horizonDays: c.horizonDays, cadenceHours: c.cadenceHours,
      claimEmissions: c.claimEmissions !== false, datanets: c.datanets, notes: c.notes,
      budget: c.budget, stake: c.stake, deliberation: c.deliberation ?? { enabled: true, votePanel: true },
      defaultModel: c.defaultModel, nodeName: c.nodeName,
    } as SafeStrategyConfig
  } catch (e) {
    // surfaced (once per request) instead of silently empty: a malformed config
    // otherwise renders a blank header with no trace anywhere.
    console.error(`orquestra: dashboard could not read strategy.config.json — ${(e as Error).message}`)
    return {}
  }
}

// veREPPO protocol constants — contract constants, fetch once and keep.
let lockConstraintsCache: LockConstraints | null = null
async function getLockConstraints(): Promise<LockConstraints | undefined> {
  if (lockConstraintsCache) return lockConstraintsCache
  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) return undefined
  try {
    lockConstraintsCache = await queryLockConstraints(rpcUrl)
    return lockConstraintsCache
  } catch { return undefined }
}

// Datanet id→name map, cached: names change rarely and the CLI call is slow.
let netNamesCache: { at: number; names: Record<string, string> } | null = null
async function datanetNames(): Promise<Record<string, string>> {
  if (netNamesCache && Date.now() - netNamesCache.at < 10 * 60_000) return netNamesCache.names
  try {
    const nets = await listDatanetsJson()
    const names = Object.fromEntries(nets.map((n) => [n.id, n.name]))
    netNamesCache = { at: Date.now(), names }
    return names
  } catch {
    return netNamesCache?.names ?? {} // tolerate CLI/RPC failure; serve stale or empty
  }
}

/** Production turn-runner: same live deps the CLI onboarding uses. */
function defaultOnboardingTurn(model: LanguageModel): (m: CoreMessage[]) => Promise<OnboardingTurnResult> {
  return (messages) => runOnboardingTurn({
    model,
    listDatanets: () => listDatanetsJson(),
    getDatanetDetails: async (id) => {
      try { return await getDatanetRubric(id) } catch (e) { return { error: (e as Error).message } }
    },
    getBalance: () => queryBalanceJson(),
  }, messages)
}

/** Apply an operator decision to a learning proposal. Accept goes through the validated
 *  config writer with an optimistic-concurrency check: if the live config value no longer
 *  matches the proposal's fromValue (a manual edit landed since), the proposal is marked
 *  stale rather than clobbering the newer value. The reflection module never writes config
 *  — only this operator-driven path does. */
export function decideProposal(dataDir: string, id: number, decision: 'accept' | 'reject'): ProposalDecisionView {
  const prop = readProposals(dataDir).find((p) => p.id === id)
  if (!prop) return { ok: false, error: 'proposal not found' }
  if (prop.status !== 'pending') return { ok: false, error: `proposal already ${prop.status}` }
  if (decision === 'reject') { setProposalStatus(dataDir, id, 'rejected'); return { ok: true, status: 'rejected' } }

  let cfg: StrategyConfig
  try { cfg = loadConfig(dataDir) } catch (e) { return { ok: false, error: `config unavailable: ${(e as Error).message}` } }
  const updated = structuredClone(cfg) as StrategyConfig

  if (prop.field === 'vote_enable') {
    // Optimistic-concurrency: if already vote-enabled, mark stale rather than no-op.
    if (updated.datanets[prop.datanetId]?.vote) {
      setProposalStatus(dataDir, id, 'stale')
      return { ok: false, status: 'stale', error: 'datanet is already vote-enabled — dismissed' }
    }
    const existing = updated.datanets[prop.datanetId]
    updated.datanets[prop.datanetId] = { ...existing, vote: true, mint: existing?.mint ?? false, strictness: existing?.strictness ?? 'balanced', mintMode: existing?.mintMode ?? 'pin', voteShare: existing?.voteShare ?? 1 }
  } else if (prop.field === 'strictness') {
    // optimistic-concurrency check — reject if live value drifted.
    const liveValue = cfg.datanets[prop.datanetId]?.strictness ?? 'balanced'
    if (liveValue !== prop.fromValue) {
      setProposalStatus(dataDir, id, 'stale')
      return { ok: false, status: 'stale', error: 'config changed since this proposal — dismissed' }
    }
    const dn = updated.datanets[prop.datanetId]
    if (!dn) { setProposalStatus(dataDir, id, 'stale'); return { ok: false, status: 'stale', error: 'datanet no longer configured' } }
    dn.strictness = prop.toValue as typeof dn.strictness
  } else if (prop.field === 'mint_enable') {
    // economics-derived proposal — same optimistic-concurrency + "must already exist"
    // posture as strictness (never silently CREATE a datanet entry from a proposal accept).
    const liveValue = String(cfg.datanets[prop.datanetId]?.mint ?? false)
    if (liveValue !== prop.fromValue) {
      setProposalStatus(dataDir, id, 'stale')
      return { ok: false, status: 'stale', error: 'config changed since this proposal — dismissed' }
    }
    const dn = updated.datanets[prop.datanetId]
    if (!dn) { setProposalStatus(dataDir, id, 'stale'); return { ok: false, status: 'stale', error: 'datanet no longer configured' } }
    dn.mint = prop.toValue === 'true'
  } else {
    // vote_share — RE-VALIDATE at apply time. Insertion-time validation lives in
    // reflect.ts; this re-check defends against a corrupted/adversarial proposals row
    // reaching decideProposal directly (parseInt('3abc') would truncate-apply as 3, and
    // the config schema deliberately has no upper bound — operators may set any positive
    // int by hand, so safeParse below would NOT catch an out-of-range proposal). Same
    // handling as a schema-parse failure: no write, no status change.
    const n = parseInt(prop.toValue, 10)
    if (!/^\d+$/.test(prop.toValue) || n < 1 || n > 10) {
      return { ok: false, error: 'invalid vote_share value in proposal — not applied' }
    }
    const liveValue = String(cfg.datanets[prop.datanetId]?.voteShare ?? 1)
    if (liveValue !== prop.fromValue) {
      setProposalStatus(dataDir, id, 'stale')
      return { ok: false, status: 'stale', error: 'config changed since this proposal — dismissed' }
    }
    const dn = updated.datanets[prop.datanetId]
    if (!dn) { setProposalStatus(dataDir, id, 'stale'); return { ok: false, status: 'stale', error: 'datanet no longer configured' } }
    dn.voteShare = parseInt(prop.toValue, 10)
  }

  const parsed = StrategyConfigSchema.safeParse(updated)
  if (!parsed.success) return { ok: false, error: 'resulting config failed validation' }
  writeConfig(dataDir, parsed.data)
  setProposalStatus(dataDir, id, 'accepted')
  return { ok: true, status: 'accepted', appliesNextCycle: true }
}

// ── read handlers ───────────────────────────────────────────────────────────────

const onboardingStatus: RouteHandler = ({ dataDir, opts }) => json(200, {
  needed: needsOnboarding(dataDir),
  chatAvailable: Boolean(opts.onboardingTurn ?? opts.resolveChatModel?.()),
} satisfies OnboardingStatusView)

const activity: RouteHandler = ({ dataDir }) => json(200, readActivity(dataDir, { limit: 500 }))

const config: RouteHandler = ({ dataDir }) => json(200, safeConfig(dataDir))

const agent: RouteHandler = ({ dataDir }) => {
  // Identity only — the apiKey NEVER leaves the store (the dashboard is unauthenticated,
  // so anything it serves is readable by whoever reaches the port: it holds no secrets).
  const a = readAgentStore(dataDir)
  return json(200, a ? ({ agentId: a.agentId, name: a.name ?? null, renameable: Boolean(a.apiKey) } satisfies AgentInfo) : null)
}

const earn: RouteHandler = ({ dataDir }) => json(200, readEarnStatus(dataDir) satisfies EarnStatus | null)

const learn: RouteHandler = ({ dataDir }) => {
  let ids: string[] = []
  try {
    const cfg = loadConfig(dataDir)
    ids = Object.entries(cfg.datanets).filter(([k, d]) => k !== '*' && (d.vote || d.mint)).map(([k]) => k)
  } catch { ids = [] } // no/invalid config (onboarding) → empty learn view
  return json(200, buildLearnView(dataDir, ids) satisfies LearnView)
}

// 7-day window: "recent health", independent of cadence (a count-based window
// means hours at high cadence, months at low). Indexed since-query — no
// full-history scan per poll.
const health: RouteHandler = ({ dataDir }) => {
  const since = Date.now() - 7 * 24 * 3600_000
  return json(200, buildHealth(readActivitySince(dataDir, since), { sinceMs: since }) satisfies HealthReport)
}

const datanets: RouteHandler = async () => json(200, await datanetNames() satisfies DatanetNames)

const models: RouteHandler = ({ opts }) => {
  // Provider/model NAMES only — never keys (the unauthenticated dashboard holds no secrets).
  const providers = (opts.availableProviders ?? []).map((provider) => ({
    provider, hasKey: true as const, models: KNOWN_MODELS[provider],
  }))
  return json(200, { providers } satisfies ModelsResponse)
}

const pnl: RouteHandler = ({ dataDir }) => {
  const snapshot = readSnapshot(dataDir)
  // claimed total must be the unbounded SQL sum, NOT a readActivity({ limit })
  // slice — a capped window drops old claims while mint spend is cumulative,
  // making net REPPO read falsely negative as the log grows.
  const p = snapshot ? derivePnl(snapshot, sumClaimedReppo(dataDir), sumMintReppoSpent(dataDir)) : null
  return json(200, { pnl: p, snapshot } satisfies PnlResponse)
}

// ── write handlers ──────────────────────────────────────────────────────────────

const onboardingChat: RouteHandler = async ({ opts, session }, req) => {
  const chatModel = opts.resolveChatModel?.() ?? null
  const turn = opts.onboardingTurn ?? (chatModel ? defaultOnboardingTurn(chatModel) : null)
  if (!turn) return json(503, { error: 'onboarding chat unavailable — node started without an LLM model' })
  const b = req.body as { message?: string; reset?: boolean }
  if (b?.reset) {
    session.messages = []; session.draft = null; session.finalized = null
    return json(200, { reset: true })
  }
  if (session.messages.length === 0) session.messages = seedOnboardingMessages()
  const msg = typeof b?.message === 'string' ? b.message.trim() : ''
  if (msg) session.messages.push({ role: 'user', content: msg })
  const r = await turn(session.messages)
  session.messages.push(...r.responseMessages)
  // Bound the retained transcript: onboarding is a short first-run window, so a very
  // long (or scripted/hostile) chat should not grow memory or per-turn token cost
  // without limit. Keep the seed system message + the most recent turns.
  const MAX_ONBOARDING_MESSAGES = 60
  if (session.messages.length > MAX_ONBOARDING_MESSAGES) {
    session.messages = [session.messages[0], ...session.messages.slice(-(MAX_ONBOARDING_MESSAGES - 1))]
  }
  if (r.draft) session.draft = { ...(session.draft ?? {}), ...r.draft }
  if (r.finalized) { session.finalized = r.finalized; session.draft = r.finalized }
  return json(200, { reply: r.text, draft: session.draft, finalized: session.finalized } satisfies OnboardingChatView)
}

const onboardingConfirm: RouteHandler = ({ dataDir, session }, req) => {
  // The single onboarding write path: validated answers → assembled config →
  // persisted exactly like the CLI flow. The waiting node sees the file appear.
  const v = validateAnswers(req.body)
  if (!v.ok) return json(400, { error: v.error })
  persistOnboarding(dataDir, buildStrategyConfig(v.answers))
  session.messages = []; session.draft = null; session.finalized = null
  return json(200, { saved: true })
}

const agentName: RouteHandler = async ({ dataDir }, req) => {
  // Rename the platform agent from the dashboard (PATCH /agents/:id upstream).
  // Same trust model as every other write here: localhost-bound, no auth — the
  // dispatcher's cross-site guard is the only browser-facing defense.
  const name = String((req.body as { name?: unknown })?.name ?? '').trim()
  if (!name || name.length > 64) return json(400, { error: 'name required (1-64 chars)' })
  try {
    const r = await syncAgentName({
      desiredName: name,
      readStored: () => readAgentStore(dataDir),
      update: (id, n, key) => updateAgentOnPlatform(id, { name: n }, key),
      writeStored: (c) => writeAgentStore(dataDir, c),
    })
    if (r === 'no-creds') return json(409, { error: 'no agent registered yet — the node registers one on its first minting start' })
    if (r === 'no-apikey') return json(409, { error: 'agent has no stored apiKey (REPPO_AGENT_ID set manually?) — cannot authenticate the rename' })
    return json(200, { name, updated: r === 'updated' } satisfies AgentRenameResult)
  } catch (e) {
    return json(502, { error: `platform rename failed: ${(e as Error).message}` })
  }
}

const strategyChat: RouteHandler = async ({ dataDir, opts }, req) => {
  const chatModel = opts.resolveChatModel?.() ?? null
  if (!chatModel) return json(503, { error: 'strategy chat unavailable — no LLM model (set a node default with a configured provider key)' })
  const messages = (req.body as { messages?: ChatMessage[] })?.messages
  if (!Array.isArray(messages) || messages.length === 0) return json(400, { error: 'messages[] required' })
  // Tolerant read (mirrors safeConfig / the write path): a missing or invalid
  // config row returns a clean 409 rather than a 500 that leaks the data-dir path.
  let current
  try {
    current = loadConfig(dataDir)
  } catch (e) {
    const msg = e instanceof ConfigNotFoundError
      ? 'no strategy config yet — finish onboarding before using the assistant'
      : 'strategy config is invalid — fix or re-onboard before using the assistant'
    return json(409, { error: msg })
  }
  const lockConstraints = await getLockConstraints()
  const snapshot = readSnapshot(dataDir)
  const result = await runStrategyChat({ messages, currentConfig: current, lockConstraints, snapshot, model: chatModel })
  return json(200, result)
}

const learnDisable: RouteHandler = ({ dataDir }, req) => {
  const b = req.body as { datanetId?: string; enabled?: boolean }
  if (!b?.datanetId || typeof b.enabled !== 'boolean') return json(400, { error: 'datanetId and enabled required' })
  setLearnEnabled(dataDir, b.datanetId, b.enabled)
  return json(200, { ok: true })
}

const runNow: RouteHandler = ({ opts }) => {
  // Off-schedule cycle trigger. The scheduler owns the no-overlap guard, so a
  // double-click or a click during a running cycle is a no-op (started:false).
  // 409 when it didn't start so the client shows why without treating it as an error.
  const trigger = opts.triggerCycle
  if (!trigger) return json(503, { error: 'node still starting — no scheduler yet' })
  const r = trigger()
  return json(r.started ? 200 : 409, r satisfies RunNowResult)
}

const learnVeto: RouteHandler = ({ dataDir }, req) => {
  const b = req.body as { datanetId?: string }
  if (!b?.datanetId) return json(400, { error: 'datanetId required' })
  clearLessons(dataDir, b.datanetId)
  return json(200, { ok: true })
}

const learnProposalDecision: RouteHandler = ({ dataDir }, req) => {
  const id = Number(req.param)
  const b = req.body as { decision?: 'accept' | 'reject' }
  if (!Number.isInteger(id) || (b?.decision !== 'accept' && b?.decision !== 'reject')) {
    return json(400, { error: 'numeric id and decision (accept|reject) required' })
  }
  const result = decideProposal(dataDir, id, b.decision)
  return json(result.ok ? 200 : 409, result)
}

const strategySave: RouteHandler = ({ dataDir }, req) => {
  const parsed = StrategyConfigSchema.safeParse(req.body)
  if (!parsed.success) return json(400, { error: 'invalid strategy config', detail: parsed.error.issues.slice(0, 5) })
  // Persist to the config row — the node hot-reloads it at the next cycle.
  writeConfig(dataDir, parsed.data)
  return json(200, { saved: true, appliesNextCycle: true } satisfies SaveStrategyResult)
}

// ── the table ───────────────────────────────────────────────────────────────────

export const routes: Route[] = [
  { method: 'GET', path: '/api/onboarding/status', handler: onboardingStatus },
  { method: 'GET', path: '/api/activity', handler: activity },
  { method: 'GET', path: '/api/config', handler: config },
  { method: 'GET', path: '/api/agent', handler: agent },
  { method: 'GET', path: '/api/earn', handler: earn },
  { method: 'GET', path: '/api/learn', handler: learn },
  { method: 'GET', path: '/api/health', handler: health },
  { method: 'GET', path: '/api/datanets', handler: datanets },
  { method: 'GET', path: '/api/models', handler: models },
  { method: 'GET', path: '/api/pnl', handler: pnl },
  { method: 'POST', path: '/api/onboarding/chat', handler: onboardingChat },
  { method: 'POST', path: '/api/onboarding/confirm', handler: onboardingConfirm },
  { method: 'POST', path: '/api/agent/name', handler: agentName },
  { method: 'POST', path: '/api/strategy/chat', handler: strategyChat },
  { method: 'POST', path: '/api/learn/disable', handler: learnDisable },
  { method: 'POST', path: '/api/run-now', handler: runNow },
  { method: 'POST', path: '/api/learn/veto', handler: learnVeto },
  { method: 'POST', path: '/api/learn/proposals/', prefix: true, handler: learnProposalDecision },
  { method: 'POST', path: '/api/strategy', handler: strategySave },
]
