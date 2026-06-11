// src/dashboard/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { writeFileSync, renameSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readActivity } from './activityLog.js'
import { readSnapshot } from './snapshot.js'
import { derivePnl } from './pnl.js'
import { readEarnStatus } from './earnStatus.js'
import { buildHealth } from './health.js'
import { StrategyConfigSchema } from '../config/schema.js'
import { runStrategyChat, type ChatMessage } from './strategyChat.js'
import { listDatanetsJson } from '../reppo/listDatanets.js'
import type { LanguageModel } from 'ai'

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), 'index.html')

export interface DashboardHandle { close(): Promise<void>; port: number }

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
      const { horizonDays, cadenceHours, claimEmissions, datanets, notes, budget, stake } = parsed.data
      return { horizonDays, cadenceHours, claimEmissions, datanets, notes, budget, stake }
    }
    // tolerant fallback for a file the schema rejects (node likely won't run on it either)
    return {
      horizonDays: c.horizonDays, cadenceHours: c.cadenceHours,
      claimEmissions: c.claimEmissions !== false, datanets: c.datanets, notes: c.notes,
      budget: c.budget, stake: c.stake,
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

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
}

/** Token gate for write routes — FAIL-CLOSED: with DASHBOARD_TOKEN unset, writes
 *  are disabled entirely (the dashboard stays read-only by default; write access
 *  is explicit opt-in). Constant-time compare to avoid timing probes. */
function writeAuth(req: IncomingMessage): { ok: true } | { ok: false; code: number; error: string } {
  const expected = (process.env.DASHBOARD_TOKEN ?? '').trim()
  if (!expected) return { ok: false, code: 503, error: 'writes disabled — set DASHBOARD_TOKEN to enable dashboard configuration' }
  const got = String(req.headers['x-orquestra-token'] ?? '')
  const a = Buffer.from(got), b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: 401, error: 'invalid token' }
  return { ok: true }
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

async function handle(dataDir: string, req: IncomingMessage, res: ServerResponse, opts: DashboardOpts): Promise<void> {
  const url = (req.url ?? '/').split('?')[0]
  try {
    if (req.method === 'POST') {
      if (url !== '/api/strategy' && url !== '/api/strategy/chat') {
        json(res, url.startsWith('/api/') ? 405 : 404, { error: url.startsWith('/api/') ? 'method not allowed' : 'not found' }); return
      }
      const auth = writeAuth(req)
      if (!auth.ok) { json(res, auth.code, { error: auth.error }); return }
      let body: unknown
      try { body = await readBody(req) } catch (e) { json(res, 400, { error: (e as Error).message }); return }

      if (url === '/api/strategy/chat') {
        if (!opts.chatModel) { json(res, 503, { error: 'strategy chat unavailable — node started without an LLM model' }); return }
        const messages = (body as { messages?: ChatMessage[] })?.messages
        if (!Array.isArray(messages) || messages.length === 0) { json(res, 400, { error: 'messages[] required' }); return }
        const currentRaw = JSON.parse(readFileSync(join(dataDir, 'strategy.config.json'), 'utf-8')) as unknown
        const current = StrategyConfigSchema.parse(currentRaw)
        const result = await runStrategyChat({ messages, currentConfig: current, model: opts.chatModel })
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
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(existsSync(HTML_PATH) ? readFileSync(HTML_PATH, 'utf-8') : '<h1>Orquestra</h1>')
      return
    }
    if (url === '/api/activity') { json(res, 200, readActivity(dataDir, { limit: 500 })); return }
    if (url === '/api/config') { json(res, 200, safeConfig(dataDir)); return }
    if (url === '/api/earn') { json(res, 200, readEarnStatus(dataDir)); return }
    // 7-day window: "recent health", independent of cadence (a count-based window
    // means hours at high cadence, months at low). 100k limit is a safety ceiling.
    if (url === '/api/health') { json(res, 200, buildHealth(readActivity(dataDir, { limit: 100_000 }), { sinceMs: Date.now() - 7 * 24 * 3600_000 })); return }
    if (url === '/api/datanets') { json(res, 200, await datanetNames()); return }
    if (url === '/favicon.ico') { res.writeHead(204); res.end(); return }
    if (url === '/api/pnl') {
      const snapshot = readSnapshot(dataDir)
      const activity = readActivity(dataDir, { limit: 5000 })
      const pnl = snapshot ? derivePnl(snapshot, activity) : null
      json(res, 200, { pnl, snapshot }); return
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
}

/** Start the read-only dashboard server. Binds 0.0.0.0 (docker -p maps the port);
 *  restrict exposure with `-p 127.0.0.1:7070:7070`. */
export interface DashboardOpts { chatModel?: LanguageModel }

export function startDashboard(dataDir: string, port: number, opts: DashboardOpts = {}): Promise<DashboardHandle> {
  const server = createServer((req, res) => { void handle(dataDir, req, res, opts) })
  return new Promise((resolve) => {
    server.listen(port, () => {
      const actual = (server.address() as AddressInfo).port
      resolve({
        port: actual,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}
