// src/dashboard/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { statSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { readActivity, readActivitySince } from './activityLog.js'
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
import { listDatanetsJson } from '../reppo/listDatanets.js'
import { needsOnboarding, persistOnboarding } from '../onboarding/persist.js'
import { buildStrategyConfig } from '../onboarding/build.js'
import { validateAnswers } from '../onboarding/schema.js'
import { runOnboardingTurn, seedOnboardingMessages, type OnboardingTurnResult } from '../onboarding/agent.js'
import type { OnboardingAnswers } from '../onboarding/types.js'
import { getDatanetRubric } from '../rubric/load.js'
import { queryBalanceJson } from '../reppo/queryBalance.js'
import type { CoreMessage, LanguageModel } from 'ai'

// The built SPA (web/ → vite build) lands in a `public/` dir next to this file.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/** Resolve a request path to a file inside publicDir, or null. The startsWith
 *  guard keeps raw `..` request paths from escaping the public dir. */
function staticFile(publicDir: string, url: string): string | null {
  const root = resolve(publicDir)
  const path = normalize(join(root, url === '/' ? '/index.html' : url))
  if (!path.startsWith(root + sep) && path !== root) return null
  try { return statSync(path).isFile() ? path : null } catch { return null }
}

export interface DashboardHandle { close(): Promise<void>; port: number; host: string }

/** A safe subset of the strategy config — explicitly whitelisted fields only. */
function safeConfig(dataDir: string): Record<string, unknown> {
  const text = readConfigText(dataDir)
  if (text === null) return {}
  try {
    const c = JSON.parse(text) as Record<string, unknown>
    // Prefer the CANONICAL schema parse (defaults + transforms applied) so the
    // strategy editor always receives a complete, Save-able config — budget and
    // stake are NOT secrets (caps already surface via the snapshot).
    const parsed = StrategyConfigSchema.safeParse(c)
    if (parsed.success) {
      const { horizonDays, cadenceHours, claimEmissions, datanets, notes, budget, stake, deliberation, defaultModel } = parsed.data
      return { horizonDays, cadenceHours, claimEmissions, datanets, notes, budget, stake, deliberation, defaultModel }
    }
    // tolerant fallback for a file the schema rejects (node likely won't run on it either).
    // deliberation falls back to the schema default so the editor reflects real behavior.
    return {
      horizonDays: c.horizonDays, cadenceHours: c.cadenceHours,
      claimEmissions: c.claimEmissions !== false, datanets: c.datanets, notes: c.notes,
      budget: c.budget, stake: c.stake, deliberation: c.deliberation ?? { enabled: true, votePanel: true },
      defaultModel: c.defaultModel,
    }
  } catch (e) {
    // surfaced (once per request) instead of silently empty: a malformed config
    // otherwise renders a blank header with no trace anywhere.
    console.error(`orquestra: dashboard could not read strategy.config.json — ${(e as Error).message}`)
    return {}
  }
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

/** One in-memory onboarding conversation per server (single-operator node).
 *  Lost on restart by design — restart simply restarts the interview. */
interface OnboardingSession {
  messages: CoreMessage[]
  draft: Partial<OnboardingAnswers> | null
  finalized: OnboardingAnswers | null
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

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
}

/** Read a JSON body (1 MiB cap — strategy configs are tiny). */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) } catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

type ProposalDecisionResult = { ok: boolean; status?: string; error?: string; appliesNextCycle?: boolean }

/** Apply an operator decision to a learning proposal. Accept goes through the validated
 *  config writer with an optimistic-concurrency check: if the live config value no longer
 *  matches the proposal's fromValue (a manual edit landed since), the proposal is marked
 *  stale rather than clobbering the newer value. The reflection module never writes config
 *  — only this operator-driven path does. */
function decideProposal(dataDir: string, id: number, decision: 'accept' | 'reject'): ProposalDecisionResult {
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
  } else {
    // strictness: optimistic-concurrency check — reject if live value drifted.
    const liveValue = cfg.datanets[prop.datanetId]?.strictness ?? 'balanced'
    if (liveValue !== prop.fromValue) {
      setProposalStatus(dataDir, id, 'stale')
      return { ok: false, status: 'stale', error: 'config changed since this proposal — dismissed' }
    }
    const dn = updated.datanets[prop.datanetId]
    if (!dn) { setProposalStatus(dataDir, id, 'stale'); return { ok: false, status: 'stale', error: 'datanet no longer configured' } }
    dn.strictness = prop.toValue as typeof dn.strictness
  }

  const parsed = StrategyConfigSchema.safeParse(updated)
  if (!parsed.success) return { ok: false, error: 'resulting config failed validation' }
  writeConfig(dataDir, parsed.data)
  setProposalStatus(dataDir, id, 'accepted')
  return { ok: true, status: 'accepted', appliesNextCycle: true }
}

const POST_ROUTES = new Set(['/api/strategy', '/api/strategy/chat', '/api/onboarding/chat', '/api/onboarding/confirm', '/api/learn/disable', '/api/learn/veto'])

async function handle(dataDir: string, req: IncomingMessage, res: ServerResponse, opts: DashboardOpts, session: OnboardingSession): Promise<void> {
  const url = (req.url ?? '/').split('?')[0]
  try {
    if (req.method === 'POST') {
      const isLearnProposal = url.startsWith('/api/learn/proposals/')
      if (!POST_ROUTES.has(url) && !isLearnProposal) {
        json(res, url.startsWith('/api/') ? 405 : 404, { error: url.startsWith('/api/') ? 'method not allowed' : 'not found' }); return
      }
      // No auth on writes: the dashboard binds localhost by default; restricting
      // exposure (the `-p 127.0.0.1:` mapping) is the operator's responsibility.
      let body: unknown
      try { body = await readBody(req) } catch (e) { json(res, 400, { error: (e as Error).message }); return }

      if (url === '/api/onboarding/chat') {
        const chatModel = opts.resolveChatModel?.() ?? null
        const turn = opts.onboardingTurn ?? (chatModel ? defaultOnboardingTurn(chatModel) : null)
        if (!turn) { json(res, 503, { error: 'onboarding chat unavailable — node started without an LLM model' }); return }
        const b = body as { message?: string; reset?: boolean }
        if (b?.reset) {
          session.messages = []; session.draft = null; session.finalized = null
          json(res, 200, { reset: true }); return
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
        json(res, 200, { reply: r.text, draft: session.draft, finalized: session.finalized })
        return
      }

      if (url === '/api/onboarding/confirm') {
        // The single onboarding write path: validated answers → assembled config →
        // persisted exactly like the CLI flow. The waiting node sees the file appear.
        const v = validateAnswers(body)
        if (!v.ok) { json(res, 400, { error: v.error }); return }
        persistOnboarding(dataDir, buildStrategyConfig(v.answers))
        session.messages = []; session.draft = null; session.finalized = null
        json(res, 200, { saved: true })
        return
      }

      if (url === '/api/strategy/chat') {
        const chatModel = opts.resolveChatModel?.() ?? null
        if (!chatModel) { json(res, 503, { error: 'strategy chat unavailable — no LLM model (set a node default with a configured provider key)' }); return }
        const messages = (body as { messages?: ChatMessage[] })?.messages
        if (!Array.isArray(messages) || messages.length === 0) { json(res, 400, { error: 'messages[] required' }); return }
        // Tolerant read (mirrors safeConfig / the write path): a missing or invalid
        // config row returns a clean 409 rather than a 500 that leaks the data-dir path.
        let current
        try {
          current = loadConfig(dataDir)
        } catch (e) {
          const msg = e instanceof ConfigNotFoundError
            ? 'no strategy config yet — finish onboarding before using the assistant'
            : 'strategy config is invalid — fix or re-onboard before using the assistant'
          json(res, 409, { error: msg }); return
        }
        const result = await runStrategyChat({ messages, currentConfig: current, model: chatModel })
        json(res, 200, result)
        return
      }

      if (url === '/api/learn/disable') {
        const b = body as { datanetId?: string; enabled?: boolean }
        if (!b?.datanetId || typeof b.enabled !== 'boolean') { json(res, 400, { error: 'datanetId and enabled required' }); return }
        setLearnEnabled(dataDir, b.datanetId, b.enabled)
        json(res, 200, { ok: true }); return
      }

      if (url === '/api/learn/veto') {
        const b = body as { datanetId?: string }
        if (!b?.datanetId) { json(res, 400, { error: 'datanetId required' }); return }
        clearLessons(dataDir, b.datanetId)
        json(res, 200, { ok: true }); return
      }

      if (isLearnProposal) {
        const id = Number(url.slice('/api/learn/proposals/'.length))
        const b = body as { decision?: 'accept' | 'reject' }
        if (!Number.isInteger(id) || (b?.decision !== 'accept' && b?.decision !== 'reject')) {
          json(res, 400, { error: 'numeric id and decision (accept|reject) required' }); return
        }
        const result = decideProposal(dataDir, id, b.decision)
        json(res, result.ok ? 200 : 409, result); return
      }

      const parsed = StrategyConfigSchema.safeParse(body)
      if (!parsed.success) { json(res, 400, { error: 'invalid strategy config', detail: parsed.error.issues.slice(0, 5) }); return }
      // Persist to the config row — the node hot-reloads it at the next cycle.
      writeConfig(dataDir, parsed.data)
      json(res, 200, { saved: true, appliesNextCycle: true })
      return
    }
    if (url === '/api/onboarding/status') {
      json(res, 200, {
        needed: needsOnboarding(dataDir),
        chatAvailable: Boolean(opts.onboardingTurn ?? opts.resolveChatModel?.()),
      })
      return
    }
    if (url === '/api/activity') { json(res, 200, readActivity(dataDir, { limit: 500 })); return }
    if (url === '/api/config') { json(res, 200, safeConfig(dataDir)); return }
    if (url === '/api/earn') { json(res, 200, readEarnStatus(dataDir)); return }
    if (url === '/api/learn') {
      let ids: string[] = []
      try {
        const cfg = loadConfig(dataDir)
        ids = Object.entries(cfg.datanets).filter(([k, d]) => k !== '*' && (d.vote || d.mint)).map(([k]) => k)
      } catch { ids = [] } // no/invalid config (onboarding) → empty learn view
      json(res, 200, buildLearnView(dataDir, ids)); return
    }
    // 7-day window: "recent health", independent of cadence (a count-based window
    // means hours at high cadence, months at low). 100k limit is a safety ceiling.
    if (url === '/api/health') {
      // 7-day window via an indexed since-query (no full-history scan per poll).
      const since = Date.now() - 7 * 24 * 3600_000
      json(res, 200, buildHealth(readActivitySince(dataDir, since), { sinceMs: since })); return
    }
    if (url === '/api/datanets') { json(res, 200, await datanetNames()); return }
    if (url === '/api/models') {
      // Provider/model NAMES only — never keys (ADR 0002: dashboard holds no secrets).
      const providers = (opts.availableProviders ?? []).map((provider) => ({
        provider, hasKey: true as const, models: KNOWN_MODELS[provider],
      }))
      json(res, 200, { providers }); return
    }
    if (url === '/api/pnl') {
      const snapshot = readSnapshot(dataDir)
      const activity = readActivity(dataDir, { limit: 5000 })
      const pnl = snapshot ? derivePnl(snapshot, activity) : null
      json(res, 200, { pnl, snapshot }); return
    }
    // Static SPA: exact asset first, then index.html fallback so client-side
    // routes deep-link. /api/* never reaches here (handled or 404'd above).
    if (req.method === 'GET' && !url.startsWith('/api/')) {
      const pubDir = opts.publicDir ?? PUBLIC_DIR
      const exact = staticFile(pubDir, url)
      if (!exact && url === '/favicon.ico') { res.writeHead(204); res.end(); return }
      const file = exact ?? staticFile(pubDir, '/index.html')
      if (file) {
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
        res.end(readFileSync(file))
        return
      }
      // no built SPA on disk (dev/test without `vite build`) — minimal placeholder at /
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<h1>Orquestra</h1>')
        return
      }
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
}

/** Start the dashboard server. Binds DASHBOARD_HOST, defaulting to loopback
 *  (127.0.0.1) so a bare `node dist/index.js` or any run that does NOT set
 *  DASHBOARD_HOST keeps the unauthenticated config/onboarding panel off the network
 *  (ADR 0002). NOTE: the published Docker image sets DASHBOARD_HOST=0.0.0.0 (the
 *  compose `127.0.0.1:7070:7070` mapping forwards to the container's bridge IP, not
 *  its loopback, so the server must bind all interfaces for that mapping to work). In
 *  Docker the host-side `127.0.0.1:` port mapping — NOT the bind — is the boundary, so
 *  `docker run -p 7070:7070 <image>` (no `127.0.0.1:` prefix) WOULD expose the panel.
 *  Operators who must expose it deliberately set DASHBOARD_HOST and should add auth first. */
export interface DashboardOpts {
  /** Resolve the current node-default chat model PER REQUEST (so a dashboard
   *  defaultModel change takes effect with no restart). Returns null when the
   *  effective default has no API key — handlers 503. */
  resolveChatModel?: () => LanguageModel | null
  /** Providers whose API key is present in env (the key registry's keys). The
   *  /api/models endpoint lists these — names only, NEVER keys. */
  availableProviders?: LlmProvider[]
  /** Override the built-SPA dir (defaults to `public/` beside this file); tests use this. */
  publicDir?: string
  /** Override the onboarding turn-runner (tests); defaults to the live model runner. */
  onboardingTurn?: (messages: CoreMessage[]) => Promise<OnboardingTurnResult>
}

export function startDashboard(dataDir: string, port: number, opts: DashboardOpts = {}): Promise<DashboardHandle> {
  const session: OnboardingSession = { messages: [], draft: null, finalized: null }
  const server = createServer((req, res) => { void handle(dataDir, req, res, opts, session) })
  // Default to loopback (see interface doc). The Docker image overrides via DASHBOARD_HOST=0.0.0.0.
  const host = process.env.DASHBOARD_HOST ?? '127.0.0.1'
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo
      resolve({
        port: addr.port,
        host: addr.address,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}
