// src/dashboard/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { writeFileSync, renameSync, statSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { readActivity, readActivitySince } from './activityLog.js'
import { readSnapshot } from './snapshot.js'
import { derivePnl } from './pnl.js'
import { readEarnStatus } from './earnStatus.js'
import { buildHealth } from './health.js'
import { StrategyConfigSchema } from '../config/schema.js'
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

/** A safe subset of strategy.config.json — explicitly whitelisted fields only. */
function safeConfig(dataDir: string): Record<string, unknown> {
  const path = join(dataDir, 'strategy.config.json')
  if (!existsSync(path)) return {}
  try {
    const c = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    // Prefer the CANONICAL schema parse (defaults + transforms applied) so the
    // strategy editor always receives a complete, Save-able config — budget and
    // stake are NOT secrets (caps already surface via the snapshot).
    const parsed = StrategyConfigSchema.safeParse(c)
    if (parsed.success) {
      const { horizonDays, cadenceHours, claimEmissions, datanets, notes, budget, stake, deliberation } = parsed.data
      return { horizonDays, cadenceHours, claimEmissions, datanets, notes, budget, stake, deliberation }
    }
    // tolerant fallback for a file the schema rejects (node likely won't run on it either).
    // deliberation falls back to the schema default so the editor reflects real behavior.
    return {
      horizonDays: c.horizonDays, cadenceHours: c.cadenceHours,
      claimEmissions: c.claimEmissions !== false, datanets: c.datanets, notes: c.notes,
      budget: c.budget, stake: c.stake, deliberation: c.deliberation ?? { enabled: true, voteBand: 1 },
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

const POST_ROUTES = new Set(['/api/strategy', '/api/strategy/chat', '/api/onboarding/chat', '/api/onboarding/confirm'])

async function handle(dataDir: string, req: IncomingMessage, res: ServerResponse, opts: DashboardOpts, session: OnboardingSession): Promise<void> {
  const url = (req.url ?? '/').split('?')[0]
  try {
    if (req.method === 'POST') {
      if (!POST_ROUTES.has(url)) {
        json(res, url.startsWith('/api/') ? 405 : 404, { error: url.startsWith('/api/') ? 'method not allowed' : 'not found' }); return
      }
      // No auth on writes: the dashboard binds localhost by default; restricting
      // exposure (the `-p 127.0.0.1:` mapping) is the operator's responsibility.
      let body: unknown
      try { body = await readBody(req) } catch (e) { json(res, 400, { error: (e as Error).message }); return }

      if (url === '/api/onboarding/chat') {
        const turn = opts.onboardingTurn ?? (opts.chatModel ? defaultOnboardingTurn(opts.chatModel) : null)
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
        persistOnboarding(dataDir, buildStrategyConfig(v.answers), v.answers.notes)
        session.messages = []; session.draft = null; session.finalized = null
        json(res, 200, { saved: true })
        return
      }

      if (url === '/api/strategy/chat') {
        if (!opts.chatModel) { json(res, 503, { error: 'strategy chat unavailable — node started without an LLM model' }); return }
        const messages = (body as { messages?: ChatMessage[] })?.messages
        if (!Array.isArray(messages) || messages.length === 0) { json(res, 400, { error: 'messages[] required' }); return }
        // Tolerant read (mirrors safeConfig / the write path): a missing or corrupt
        // config returns a clean 409 rather than a 500 that leaks the data-dir path.
        const cfgPath = join(dataDir, 'strategy.config.json')
        if (!existsSync(cfgPath)) { json(res, 409, { error: 'no strategy config yet — finish onboarding before using the assistant' }); return }
        let parsedCfg
        try {
          parsedCfg = StrategyConfigSchema.safeParse(JSON.parse(readFileSync(cfgPath, 'utf-8')))
        } catch {
          json(res, 409, { error: 'strategy config is unreadable — fix or re-onboard before using the assistant' }); return
        }
        if (!parsedCfg.success) { json(res, 409, { error: 'strategy config is invalid — fix or re-onboard before using the assistant' }); return }
        const result = await runStrategyChat({ messages, currentConfig: parsedCfg.data, model: opts.chatModel })
        json(res, 200, result)
        return
      }

      const parsed = StrategyConfigSchema.safeParse(body)
      if (!parsed.success) { json(res, 400, { error: 'invalid strategy config', detail: parsed.error.issues.slice(0, 5) }); return }
      // Atomic write (temp + rename) — the node hot-reloads it at the next cycle.
      const finalPath = join(dataDir, 'strategy.config.json')
      const tmpPath = finalPath + '.tmp'
      writeFileSync(tmpPath, JSON.stringify(parsed.data, null, 2))
      renameSync(tmpPath, finalPath)
      json(res, 200, { saved: true, appliesNextCycle: true })
      return
    }
    if (url === '/api/onboarding/status') {
      json(res, 200, {
        needed: needsOnboarding(dataDir),
        chatAvailable: Boolean(opts.onboardingTurn ?? opts.chatModel),
      })
      return
    }
    if (url === '/api/activity') { json(res, 200, readActivity(dataDir, { limit: 500 })); return }
    if (url === '/api/config') { json(res, 200, safeConfig(dataDir)); return }
    if (url === '/api/earn') { json(res, 200, readEarnStatus(dataDir)); return }
    // 7-day window: "recent health", independent of cadence (a count-based window
    // means hours at high cadence, months at low). 100k limit is a safety ceiling.
    if (url === '/api/health') {
      // 7-day window via an indexed since-query (no full-history scan per poll).
      const since = Date.now() - 7 * 24 * 3600_000
      json(res, 200, buildHealth(readActivitySince(dataDir, since), { sinceMs: since })); return
    }
    if (url === '/api/datanets') { json(res, 200, await datanetNames()); return }
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
  chatModel?: LanguageModel
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
