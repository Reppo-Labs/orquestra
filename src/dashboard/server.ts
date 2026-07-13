// src/dashboard/server.ts
// Transport layer only: HTTP plumbing, the cross-site write guards, JSON body
// parsing, static SPA serving, and the dispatcher that walks the route table.
// The endpoints themselves live in routes.ts as plain functions.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { statSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { matchRoute, routes, type ApiResponse, type DashboardOpts, type OnboardingSession, type RouteContext } from './routes.js'

export type { DashboardOpts } from './routes.js'

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
      const text = Buffer.concat(chunks).toString('utf-8').trim()
      // An empty body is valid for bodyless triggers (e.g. POST /api/run-now); resolve {}
      // so the route's own validator decides. Non-empty bodies must still be valid JSON.
      if (text === '') { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

/** Hostnames a browser legitimately presents when reaching the dashboard. Direct
 *  use AND the documented Docker deployment both arrive as localhost: the compose
 *  `127.0.0.1:7070:7070` mapping + SSH tunnel terminate on the operator's own
 *  loopback, so the browser's Host header is `localhost:<port>` (or 127.0.0.1)
 *  even though the container binds 0.0.0.0. */
const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  // IPv4-mapped IPv6 loopback: some stacks accept these forms for 127.0.0.1.
  '::ffff:127.0.0.1',
  '[::ffff:127.0.0.1]',
])

/** Operators who deliberately expose the unauthenticated panel behind a name
 *  (they should put auth in front first — exposure equals full control of
 *  strategy + budget) can extend the write allowlist: comma-separated hostnames,
 *  no ports. Read per request so tests (and a restart-less env tweak) see changes. */
function extraAllowedHosts(): Set<string> {
  const raw = process.env.DASHBOARD_ALLOWED_HOSTS
  if (!raw) return new Set()
  return new Set(raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))
}

/** Host header without the port, trailing DNS dot removed. Handles the
 *  `[::1]:7070` bracket form. `localhost.` resolves identically to `localhost`
 *  in DNS, so the fully-qualified trailing dot must not slip past the allowlist. */
function stripPort(hostHeader: string): string {
  let host: string
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    host = end === -1 ? hostHeader : hostHeader.slice(0, end + 1)
  } else {
    host = hostHeader.replace(/:\d+$/, '')
  }
  return host.replace(/\.$/, '')
}

/** The minimal request surface the guard and dispatcher need (tests fake this). */
export interface RequestLike {
  method?: string
  url?: string
  headers: IncomingMessage['headers']
}

/** Defense-in-depth for the mutating routes. The panel is unauthenticated and
 *  localhost-bound by design (no login — exposure equals full control of strategy
 *  + budget, so it is reached over an SSH tunnel), which makes CSRF/DNS-rebinding
 *  from a page the operator's browser happens to visit the realistic remote path
 *  to the budget/strategy. Three additive checks; returns a rejection reason or
 *  null when the write may proceed. GET routes and the static SPA are deliberately
 *  untouched. */
function crossSiteWriteError(req: RequestLike): string | null {
  // 1) Host allowlist. A DNS-rebinding page reaches this server with the
  //    ATTACKER'S hostname in Host (the browser thinks it is talking to
  //    attacker.example); legitimate access always presents localhost.
  const hostHeader = req.headers.host
  const host = hostHeader ? stripPort(hostHeader).toLowerCase() : ''
  if (!LOOPBACK_HOSTS.has(host) && !extraAllowedHosts().has(host)) {
    return `host "${hostHeader ?? ''}" not allowed for writes — the dashboard accepts localhost only (extend with DASHBOARD_ALLOWED_HOSTS)`
  }
  // 2) Fetch metadata: modern browsers stamp cross-site requests. An absent
  //    header (older client, curl, node) passes — this check is purely additive.
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') {
    return 'cross-site request rejected'
  }
  // 3) Content-Type: writes are JSON. A cross-origin form or no-cors fetch can
  //    send text/plain / form encodings WITHOUT a CORS preflight; requiring
  //    application/json closes that. An ABSENT content-type stays allowed for
  //    bodyless triggers (e.g. POST /api/run-now with no body).
  const ct = req.headers['content-type']
  if (ct !== undefined && ct.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return `unsupported content-type "${ct}" — dashboard writes require application/json`
  }
  return null
}

/** Walk the route table and produce a JSON response, or null when nothing matched
 *  (the caller falls through to the static SPA / final 404). Transport is applied
 *  exactly once, ahead of every handler:
 *  - writes (POST): route match → cross-site guard → body parse → handler. No auth
 *    beyond that: the dashboard binds localhost by default; restricting exposure
 *    (the `-p 127.0.0.1:` mapping) is the operator's responsibility. The guard adds
 *    browser-facing defense-in-depth (CSRF/DNS-rebinding) on top — it never gates
 *    same-machine tools like curl.
 *  - reads (any other method): route match → handler. Deliberately unguarded. */
export async function dispatch(ctx: RouteContext, req: RequestLike, readBodyFn: () => Promise<unknown>): Promise<ApiResponse | null> {
  const url = (req.url ?? '/').split('?')[0]
  const method = req.method ?? 'GET'
  if (method === 'POST') {
    const m = matchRoute(routes, 'POST', url)
    if (!m) {
      return url.startsWith('/api/')
        ? { status: 405, body: { error: 'method not allowed' } }
        : { status: 404, body: { error: 'not found' } }
    }
    const guardError = crossSiteWriteError(req)
    if (guardError) return { status: 403, body: { error: guardError } }
    let body: unknown
    try { body = await readBodyFn() } catch (e) { return { status: 400, body: { error: (e as Error).message } } }
    return m.route.handler(ctx, { url, method, body, param: m.param })
  }
  const m = matchRoute(routes, 'GET', url)
  if (!m) return null
  return m.route.handler(ctx, { url, method, param: m.param })
}

async function handle(ctx: RouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url ?? '/').split('?')[0]
  try {
    const out = await dispatch(ctx, req, () => readBody(req))
    if (out) { json(res, out.status, out.body); return }
    // Static SPA: exact asset first, then index.html fallback so client-side
    // routes deep-link. /api/* never reaches here (handled or 404'd below).
    if (req.method === 'GET' && !url.startsWith('/api/')) {
      const pubDir = ctx.opts.publicDir ?? PUBLIC_DIR
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
 *  (it has no login — exposure equals full control of strategy + budget). NOTE: the
 *  published Docker image sets DASHBOARD_HOST=0.0.0.0 (the compose `127.0.0.1:7070:7070`
 *  mapping forwards to the container's bridge IP, not its loopback, so the server must
 *  bind all interfaces for that mapping to work). In Docker the host-side `127.0.0.1:`
 *  port mapping — NOT the bind — is the boundary, so `docker run -p 7070:7070 <image>`
 *  (no `127.0.0.1:` prefix) WOULD expose the panel. Operators who must expose it
 *  deliberately set DASHBOARD_HOST and should add auth first. */
export function startDashboard(dataDir: string, port: number, opts: DashboardOpts = {}): Promise<DashboardHandle> {
  const session: OnboardingSession = { messages: [], draft: null, finalized: null }
  const ctx: RouteContext = { dataDir, opts, session }
  const server = createServer((req, res) => { void handle(ctx, req, res) })
  // Default to loopback (see doc above). The Docker image overrides via DASHBOARD_HOST=0.0.0.0.
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
