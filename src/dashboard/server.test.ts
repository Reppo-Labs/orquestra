import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDashboard, type DashboardHandle } from './server.js'
import { appendActivity } from './activityLog.js'
import { writeEarnStatus } from './earnStatus.js'

let dir: string
let handle: DashboardHandle
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orq-srv-'))
  writeFileSync(join(dir, 'strategy.config.json'), JSON.stringify({
    horizonDays: 30, cadenceHours: 1, claimEmissions: true,
    stake: { lockReppo: 0, lockDurationDays: 30 },
    budget: { voteGasEthMax: 0.05, voteRateMaxPerCycle: 30, mintReppoMax: 500, mintGasEthMax: 0.05, claimGasEthMax: 0.05 },
    datanets: { '9': { vote: true, mint: false, strictness: 'balanced' } }, notes: '',
  }))
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
    writeEarnStatus(dir, { ts: 't', mintedPods: 1, claimedReppo: 0, claimableReppo: 5, totalUpVotes: 2, totalDownVotes: 0, pods: [], earning: true })
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
  budget: { voteGasEthMax: 0.02, voteRateMaxPerCycle: 13, mintReppoMax: 50, mintGasEthMax: 0.01 },
  datanets: { '2': { vote: true, mint: false, strictness: 'balanced' } },
  notes: 'from dashboard test',
}

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.text() }
}

describe('write layer — token gate (fail-closed)', () => {
  it('writes are DISABLED (503) when DASHBOARD_TOKEN is unset', async () => {
    delete process.env.DASHBOARD_TOKEN
    const r = await post('/api/strategy', VALID_STRATEGY)
    expect(r.status).toBe(503)
    expect(r.body).toMatch(/writes disabled/i)
  })

  it('rejects a wrong/missing token with 401 when DASHBOARD_TOKEN is set', async () => {
    process.env.DASHBOARD_TOKEN = 'secret-token'
    try {
      expect((await post('/api/strategy', VALID_STRATEGY)).status).toBe(401)
      expect((await post('/api/strategy', VALID_STRATEGY, { 'x-orquestra-token': 'wrong' })).status).toBe(401)
    } finally { delete process.env.DASHBOARD_TOKEN }
  })

  it('accepts a valid strategy with the right token, writes atomically, GET reflects it', async () => {
    process.env.DASHBOARD_TOKEN = 'secret-token'
    try {
      const r = await post('/api/strategy', VALID_STRATEGY, { 'x-orquestra-token': 'secret-token' })
      expect(r.status).toBe(200)
      const saved = JSON.parse(readFileSync(join(dir, 'strategy.config.json'), 'utf-8'))
      expect(saved.notes).toBe('from dashboard test')
      const cfg = await get('/api/config')
      expect(JSON.parse(cfg.body).notes).toBe('from dashboard test')
    } finally { delete process.env.DASHBOARD_TOKEN }
  })

  it('rejects an invalid strategy with 400 + zod detail, file untouched', async () => {
    process.env.DASHBOARD_TOKEN = 'secret-token'
    try {
      const before = readFileSync(join(dir, 'strategy.config.json'), 'utf-8')
      const r = await post('/api/strategy', { horizonDays: -1 }, { 'x-orquestra-token': 'secret-token' })
      expect(r.status).toBe(400)
      expect(readFileSync(join(dir, 'strategy.config.json'), 'utf-8')).toBe(before) // no write
    } finally { delete process.env.DASHBOARD_TOKEN }
  })

  it('POST to a read-only route → 405', async () => {
    process.env.DASHBOARD_TOKEN = 'secret-token'
    try {
      expect((await post('/api/health', {}, { 'x-orquestra-token': 'secret-token' })).status).toBe(405)
    } finally { delete process.env.DASHBOARD_TOKEN }
  })
})

describe('POST /api/strategy/chat', () => {
  it('is token-gated like /api/strategy (503 unset, 401 wrong)', async () => {
    delete process.env.DASHBOARD_TOKEN
    expect((await post('/api/strategy/chat', { messages: [{ role: 'user', content: 'hi' }] })).status).toBe(503)
    process.env.DASHBOARD_TOKEN = 'secret-token'
    try {
      expect((await post('/api/strategy/chat', { messages: [{ role: 'user', content: 'hi' }] }, { 'x-orquestra-token': 'nope' })).status).toBe(401)
    } finally { delete process.env.DASHBOARD_TOKEN }
  })

  it('503 when the server has no chat model (this test server passes none)', async () => {
    process.env.DASHBOARD_TOKEN = 'secret-token'
    try {
      const r = await post('/api/strategy/chat', { messages: [{ role: 'user', content: 'hi' }] }, { 'x-orquestra-token': 'secret-token' })
      expect(r.status).toBe(503)
      expect(r.body).toMatch(/chat unavailable/i)
    } finally { delete process.env.DASHBOARD_TOKEN }
  })
})

describe('GET /api/datanets', () => {
  it('returns an id→name object; tolerates a missing reppo CLI by serving {}', async () => {
    const r = await get('/api/datanets')
    expect(r.status).toBe(200)
    expect(typeof JSON.parse(r.body)).toBe('object') // {} in tests (no CLI on PATH with creds)
  })
})
