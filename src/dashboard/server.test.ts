import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { startDashboard, type DashboardHandle } from './server.js'
import { appendActivity } from './activityLog.js'
import { writeEarnStatus } from './earnStatus.js'
import { writeConfig, readConfigText } from '../config/load.js'

let dir: string
let handle: DashboardHandle
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orq-srv-'))
  writeConfig(dir, {
    horizonDays: 30, cadenceHours: 1, claimEmissions: true,
    stake: { lockReppo: 0, lockDurationDays: 30 },
    budget: { voteRateMaxPerCycle: 30, mintReppoMax: 500, claimGasEthMax: 0.05 },
    datanets: { '9': { vote: true, mint: false, strictness: 'balanced' } }, notes: '',
  } as never)
  appendActivity(dir, { ts: 't', cycleId: 'c1', kind: 'vote', datanetId: '9', podId: '1', direction: 'up', conviction: 9, reason: 'r', status: 'executed', txHash: '0x1' })
  handle = await startDashboard(dir, 0)
})
afterEach(async () => { await handle.close(); rmSync(dir, { recursive: true, force: true }) })

const get = async (path: string) => {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`)
  return { status: res.status, body: await res.text() }
}

describe('dashboard server', () => {
  it('serves html at /', async () => {
    const r = await get('/')
    expect(r.status).toBe(200)
    expect(r.body.toLowerCase()).toContain('orquestra')
  })
  it('/api/activity returns recorded entries', async () => {
    const r = await get('/api/activity')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)[0].podId).toBe('1')
  })
  it('/api/pnl returns a {pnl,snapshot} object (null snapshot tolerated)', async () => {
    const r = await get('/api/pnl')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toHaveProperty('pnl')
  })
  it('/api/config is a COMPLETE strategy config (grid Save must round-trip)', async () => {
    const r = await get('/api/config')
    const body = JSON.parse(r.body)
    expect(body).toHaveProperty('budget')
    expect(body).toHaveProperty('stake')
  })

  it('/api/config strips secrets', async () => {
    const r = await get('/api/config')
    expect(r.status).toBe(200)
    expect(r.body).not.toMatch(/PRIVATE_KEY|inf_|0x[a-fA-F0-9]{64}/)
    expect(JSON.parse(r.body)).toHaveProperty('cadenceHours')
  })
  it('/api/earn returns the persisted earn status', async () => {
    writeEarnStatus(dir, { ts: 't', mintedPods: 1, claimedReppo: 0, claimedTokens: [], claimableReppo: 5, totalUpVotes: 2, totalDownVotes: 0, pods: [], earning: true })
    const r = await get('/api/earn')
    expect(r.status).toBe(200)
    const body = JSON.parse(r.body)
    expect(body).toMatchObject({ mintedPods: 1, claimableReppo: 5, earning: true })
  })

  it('/api/health aggregates activity into per-datanet counts', async () => {
    appendActivity(dir, {
      ts: 't2', cycleId: 'c2', kind: 'skip', datanetId: '2',
      reason: 'subnet access not granted (grant-access refused-budget: grant REPPO budget exhausted)',
      status: 'skipped',
    })
    const r = await get('/api/health')
    expect(r.status).toBe(200)
    const body = JSON.parse(r.body)
    const d9 = body.datanets.find((d: { datanetId: string }) => d.datanetId === '9')
    expect(d9.votes.executed).toBe(1)
    const d2 = body.datanets.find((d: { datanetId: string }) => d.datanetId === '2')
    expect(d2.skips).toBe(1)
    expect(d2.lastSkipReason).toMatch(/subnet access not granted/)
  })

  it('unknown path → 404', async () => {
    expect((await get('/nope')).status).toBe(404)
  })
})

const VALID_STRATEGY = {
  horizonDays: 7, cadenceHours: 1,
  stake: { lockReppo: 0, lockDurationDays: 7 },
  budget: { voteRateMaxPerCycle: 13, mintReppoMax: 50, mintGasEthMax: 0.01 },
  datanets: { '2': { vote: true, mint: false, strictness: 'balanced' } },
  notes: 'from dashboard test',
}

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.text() }
}

describe('write layer (unauthenticated — localhost-bound by default)', () => {
  it('accepts a valid strategy without any token, writes atomically, GET reflects it', async () => {
    const r = await post('/api/strategy', VALID_STRATEGY)
    expect(r.status).toBe(200)
    const saved = JSON.parse(readConfigText(dir)!)
    expect(saved.notes).toBe('from dashboard test')
    const cfg = await get('/api/config')
    expect(JSON.parse(cfg.body).notes).toBe('from dashboard test')
  })

  it('rejects an invalid strategy with 400 + zod detail, file untouched', async () => {
    const before = readConfigText(dir)
    const r = await post('/api/strategy', { horizonDays: -1 })
    expect(r.status).toBe(400)
    expect(readConfigText(dir)).toBe(before) // no write
  })

  it('POST to a read-only route → 405', async () => {
    expect((await post('/api/health', {})).status).toBe(405)
  })
})

describe('POST /api/run-now', () => {
  it('503 when no triggerCycle is wired (scheduler not up yet)', async () => {
    // The default handle (this file's beforeEach) has no triggerCycle.
    expect((await post('/api/run-now', {})).status).toBe(503)
  })

  it('200 { started:true } when the trigger starts a cycle', async () => {
    const d = mkdtempSync(join(tmpdir(), 'orq-run-'))
    const h = await startDashboard(d, 0, { triggerCycle: () => ({ started: true }) })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/run-now`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json()).started).toBe(true)
    await h.close(); rmSync(d, { recursive: true, force: true })
  })

  it('409 { started:false, reason } when a cycle is already running', async () => {
    const d = mkdtempSync(join(tmpdir(), 'orq-run-'))
    const h = await startDashboard(d, 0, { triggerCycle: () => ({ started: false, reason: 'a cycle is already running' }) })
    const res = await fetch(`http://127.0.0.1:${h.port}/api/run-now`, { method: 'POST' })
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toMatch(/already running/)
    await h.close(); rmSync(d, { recursive: true, force: true })
  })
})

describe('POST /api/strategy/chat', () => {
  it('503 when the server has no chat model (this test server passes none)', async () => {
    const r = await post('/api/strategy/chat', { messages: [{ role: 'user', content: 'hi' }] })
    expect(r.status).toBe(503)
    expect(r.body).toMatch(/chat unavailable/i)
  })

  it('strategy chat uses resolveChatModel() per request (503 when it returns null)', async () => {
    const cdir = mkdtempSync(join(tmpdir(), 'orq-chat-'))
    writeConfig(cdir, {
      horizonDays: 30, cadenceHours: 1, claimEmissions: true,
      stake: { lockReppo: 0, lockDurationDays: 30 },
      budget: { voteRateMaxPerCycle: 30, mintReppoMax: 500, claimGasEthMax: 0.05 },
      datanets: { '9': { vote: true, mint: false, strictness: 'balanced' } }, notes: '',
    } as never)
    const ch = await startDashboard(cdir, 0, { resolveChatModel: () => null })
    try {
      const res = await fetch(`http://127.0.0.1:${ch.port}/api/strategy/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(res.status).toBe(503)
    } finally { await ch.close(); rmSync(cdir, { recursive: true, force: true }) }
  })
})

describe('static SPA serving (publicDir)', () => {
  let pub: string
  let spa: DashboardHandle
  beforeEach(async () => {
    pub = mkdtempSync(join(tmpdir(), 'orq-pub-'))
    writeFileSync(join(pub, 'index.html'), '<html><body>orquestra spa</body></html>')
    mkdirSync(join(pub, 'assets'))
    writeFileSync(join(pub, 'assets', 'app.js'), 'console.log("spa")')
    spa = await startDashboard(dir, 0, { publicDir: pub })
  })
  afterEach(async () => { await spa.close(); rmSync(pub, { recursive: true, force: true }) })

  const getSpa = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${spa.port}${path}`)
    return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() }
  }

  it('serves index.html at / with html content type', async () => {
    const r = await getSpa('/')
    expect(r.status).toBe(200)
    expect(r.type).toMatch(/text\/html/)
    expect(r.body).toContain('orquestra spa')
  })

  it('serves assets with their content type', async () => {
    const r = await getSpa('/assets/app.js')
    expect(r.status).toBe(200)
    expect(r.type).toMatch(/javascript/)
    expect(r.body).toContain('spa')
  })

  it('falls back to index.html for unknown non-API routes (SPA deep links)', async () => {
    const r = await getSpa('/some/client/route')
    expect(r.status).toBe(200)
    expect(r.body).toContain('orquestra spa')
  })

  it('API routes are NOT swallowed by the SPA fallback', async () => {
    const r = await getSpa('/api/config')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toHaveProperty('cadenceHours')
  })

  it('path traversal cannot escape the public dir', async () => {
    // raw http request: fetch() would normalize the .. segments client-side
    const body = await new Promise<string>((resolveP, rejectP) => {
      const req = httpRequest({ host: '127.0.0.1', port: spa.port, path: '/../strategy.config.json' }, (res) => {
        let s = ''
        res.on('data', (c) => { s += c })
        res.on('end', () => resolveP(s))
      })
      req.on('error', rejectP)
      req.end()
    })
    expect(body).not.toContain('horizonDays') // must not leak the data dir
  })
})

const VALID_ANSWERS = {
  datanets: [{ id: '9', vote: true, mint: false, strictness: 'balanced' }],
  lockReppo: 0, lockDurationDays: 30, voteRateMaxPerCycle: 25,
  mintReppoMax: 100, horizonDays: 30, cadenceHours: 6, notes: 'dashboard onboarding test',
}

describe('onboarding API', () => {
  let freshDir: string
  let onb: DashboardHandle
  const fakeTurn = async (messages: { role: string; content: unknown }[]) => {
    const users = messages.filter((m) => m.role === 'user').length
    if (String(messages[messages.length - 1]?.content).includes('finalize now')) {
      return { text: 'Done — review and confirm.', responseMessages: [{ role: 'assistant' as const, content: 'Done — review and confirm.' }], finalized: VALID_ANSWERS as never, draft: null }
    }
    return {
      text: `turn with ${users} user message(s)`,
      responseMessages: [{ role: 'assistant' as const, content: 'ok' }],
      finalized: null,
      draft: users > 1 ? { cadenceHours: 6 } : null,
    }
  }
  beforeEach(async () => {
    freshDir = mkdtempSync(join(tmpdir(), 'orq-onb-')) // NO strategy.config.json → onboarding needed
    onb = await startDashboard(freshDir, 0, { onboardingTurn: fakeTurn as never })
  })
  afterEach(async () => {
    await onb.close()
    rmSync(freshDir, { recursive: true, force: true })
  })

  const onbGet = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${onb.port}${path}`)
    return { status: res.status, body: JSON.parse(await res.text()) }
  }
  const onbPost = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${onb.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: JSON.parse(await res.text()) }
  }

  it('status reports needed=true on a fresh data dir, false once config exists', async () => {
    expect((await onbGet('/api/onboarding/status')).body).toMatchObject({ needed: true, chatAvailable: true })
    const r = await fetch(`http://127.0.0.1:${handle.port}/api/onboarding/status`) // outer server HAS a config
    expect(((await r.json()) as { needed: boolean }).needed).toBe(false)
  })

  it('chat is 503 when no model and no injected turn runner', async () => {
    const bare = await startDashboard(freshDir, 0, {})
    try {
      const res = await fetch(`http://127.0.0.1:${bare.port}/api/onboarding/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(res.status).toBe(503)
    } finally { await bare.close() }
  })

  it('chat keeps a session across turns and surfaces drafts and finalized answers', async () => {
    const first = await onbPost('/api/onboarding/chat', {})
    expect(first.status).toBe(200)
    expect(first.body.reply).toMatch(/1 user message/) // seed message only
    expect(first.body.finalized).toBeNull()

    const second = await onbPost('/api/onboarding/chat', { message: 'vote on 9' })
    expect(second.body.reply).toMatch(/2 user message/) // session grew
    expect(second.body.draft).toMatchObject({ cadenceHours: 6 })

    const third = await onbPost('/api/onboarding/chat', { message: 'finalize now' })
    expect(third.body.finalized).toMatchObject({ notes: 'dashboard onboarding test' })
  })

  it('chat reset clears the session', async () => {
    await onbPost('/api/onboarding/chat', { message: 'hello' })
    await onbPost('/api/onboarding/chat', { reset: true })
    const r = await onbPost('/api/onboarding/chat', {})
    expect(r.body.reply).toMatch(/1 user message/)
  })

  it('confirm validates, persists config + notes, and flips status.needed', async () => {
    expect((await onbPost('/api/onboarding/confirm', { horizonDays: -1 })).status).toBe(400)
    const ok = await onbPost('/api/onboarding/confirm', VALID_ANSWERS)
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ saved: true })
    const saved = JSON.parse(readConfigText(freshDir)!)
    expect(saved.cadenceHours).toBe(6)
    expect(saved.notes).toMatch(/dashboard onboarding test/) // brief lives in config.notes
    expect((await onbGet('/api/onboarding/status')).body.needed).toBe(false)
  })
})

describe('GET /api/datanets', () => {
  it('returns an id→name object; tolerates a missing reppo CLI by serving {}', async () => {
    const r = await get('/api/datanets')
    expect(r.status).toBe(200)
    expect(typeof JSON.parse(r.body)).toBe('object') // {} in tests (no CLI on PATH with creds)
  })
})

describe('GET /api/models', () => {
  let mdir: string
  let mh: DashboardHandle
  beforeEach(async () => {
    mdir = mkdtempSync(join(tmpdir(), 'orq-models-'))
    mh = await startDashboard(mdir, 0, { availableProviders: ['google', 'virtuals'] })
  })
  afterEach(async () => { await mh.close(); rmSync(mdir, { recursive: true, force: true }) })

  const mget = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${mh.port}${path}`)
    return { status: res.status, body: await res.text() }
  }

  it('lists only providers with a key, each with hasKey:true and a models[]', async () => {
    const r = await mget('/api/models')
    expect(r.status).toBe(200)
    const body = JSON.parse(r.body) as { providers: { provider: string; hasKey: boolean; models: string[] }[] }
    const provs = body.providers.map((p) => p.provider).sort()
    expect(provs).toEqual(['google', 'virtuals'])
    for (const p of body.providers) {
      expect(p.hasKey).toBe(true)
      expect(Array.isArray(p.models)).toBe(true)
      expect(p.models.length).toBeGreaterThan(0)
    }
  })

  it('returns NO secrets (no api keys in the body)', async () => {
    const r = await mget('/api/models')
    expect(r.body).not.toMatch(/acp[_-]|inf_|sk-|AIza|api[_-]?key/i)
  })

  it('returns an empty providers list when no provider has a key', async () => {
    const bare = await startDashboard(mdir, 0, {})
    try {
      const res = await fetch(`http://127.0.0.1:${bare.port}/api/models`)
      const body = (await res.json()) as { providers: unknown[] }
      expect(body.providers).toEqual([])
    } finally { await bare.close() }
  })
})

describe('network bind (ADR 0002: unauthenticated panel must not default to a public interface)', () => {
  const saved = process.env.DASHBOARD_HOST
  afterEach(() => { if (saved === undefined) delete process.env.DASHBOARD_HOST; else process.env.DASHBOARD_HOST = saved })

  it('defaults to loopback (127.0.0.1) when DASHBOARD_HOST is unset', async () => {
    delete process.env.DASHBOARD_HOST
    const h = await startDashboard(mkdtempSync(join(tmpdir(), 'orq-bind-')), 0)
    expect(h.host).toBe('127.0.0.1')
    await h.close()
  })

  it('honors DASHBOARD_HOST override (e.g. 0.0.0.0 inside the Docker image)', async () => {
    process.env.DASHBOARD_HOST = '0.0.0.0'
    const h = await startDashboard(mkdtempSync(join(tmpdir(), 'orq-bind-')), 0)
    expect(h.host).toBe('0.0.0.0')
    await h.close()
  })
})
