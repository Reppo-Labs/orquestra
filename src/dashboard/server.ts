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

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), 'index.html')

export interface DashboardHandle { close(): Promise<void>; port: number }

/** A safe subset of strategy.config.json — explicitly whitelisted fields only. */
function safeConfig(dataDir: string): Record<string, unknown> {
  const path = join(dataDir, 'strategy.config.json')
  if (!existsSync(path)) return {}
  try {
    const c = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    return {
      horizonDays: c.horizonDays, cadenceHours: c.cadenceHours,
      // raw file may omit the key; the schema defaults it to true — mirror that here
      // so the header doesn't claim "claim off" for a node that IS claiming.
      claimEmissions: c.claimEmissions !== false, datanets: c.datanets, notes: c.notes,
    }
  } catch (e) {
    // surfaced (once per request) instead of silently empty: a malformed config
    // otherwise renders a blank header with no trace anywhere.
    console.error(`orquestra: dashboard could not read strategy.config.json — ${(e as Error).message}`)
    return {}
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

async function handle(dataDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url ?? '/').split('?')[0]
  try {
    if (req.method === 'POST') {
      if (url !== '/api/strategy') { json(res, url.startsWith('/api/') ? 405 : 404, { error: url.startsWith('/api/') ? 'method not allowed' : 'not found' }); return }
      const auth = writeAuth(req)
      if (!auth.ok) { json(res, auth.code, { error: auth.error }); return }
      let body: unknown
      try { body = await readBody(req) } catch (e) { json(res, 400, { error: (e as Error).message }); return }
      const parsed = StrategyConfigSchema.safeParse(body)
      if (!parsed.success) { json(res, 400, { error: 'invalid strategy config', detail: parsed.error.issues.slice(0, 5) }); return }
      // Atomic write (temp + rename) — the node hot-reloads it at the next cycle.
      const finalPath = join(dataDir, 'strategy.config.json')
      const tmpPath = finalPath + '.tmp'
      writeFileSync(tmpPath, JSON.stringify(body, null, 2))
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
export function startDashboard(dataDir: string, port: number): Promise<DashboardHandle> {
  const server = createServer((req, res) => { void handle(dataDir, req, res) })
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
