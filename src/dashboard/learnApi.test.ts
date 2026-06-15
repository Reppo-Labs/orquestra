import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDashboard, type DashboardHandle } from './server.js'
import { writeConfig, readConfigText } from '../config/load.js'
import { insertLesson, insertProposal, readProposals } from '../learn/store.js'

let dir: string
let handle: DashboardHandle

const baseConfig = () => ({
  horizonDays: 30, cadenceHours: 1, claimEmissions: true,
  stake: { lockReppo: 0, lockDurationDays: 30 },
  budget: { voteRateMaxPerCycle: 30, mintReppoMax: 500 },
  deliberation: { enabled: true, voteBand: 1 },
  datanets: { '9': { vote: true, mint: true, strictness: 'balanced' } }, notes: '',
})

const lesson = () => ({ datanetId: '9', text: 'high-conviction aligned 40%', source: 'calibration' as const, createdEpoch: 100, createdTs: '2026-06-15T00:00:00.000Z', active: 1 as const })
const proposal = (over: Partial<{ fromValue: string; toValue: string }> = {}) => ({
  datanetId: '9', field: 'strictness' as const, fromValue: over.fromValue ?? 'balanced', toValue: over.toValue ?? 'conservative',
  rationale: 'reversals 4', basisConfigMtime: '2026-06-15T00:00:00.000Z', createdEpoch: 100, createdTs: '2026-06-15T00:00:00.000Z',
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orq-learnapi-'))
  writeConfig(dir, baseConfig() as never)
  handle = await startDashboard(dir, 0)
})
afterEach(async () => { await handle.close(); rmSync(dir, { recursive: true, force: true }) })

const get = async (path: string) => { const r = await fetch(`http://127.0.0.1:${handle.port}${path}`); return { status: r.status, body: await r.json() } }
const post = async (path: string, body: unknown) => {
  const r = await fetch(`http://127.0.0.1:${handle.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}

describe('GET /api/learn', () => {
  it('returns per-datanet enabled/lessons/stats and pending proposals', async () => {
    insertLesson(dir, lesson())
    insertProposal(dir, proposal())
    const r = await get('/api/learn')
    expect(r.status).toBe(200)
    expect(r.body.datanets['9']).toMatchObject({ enabled: true })
    expect(r.body.datanets['9'].lessons).toHaveLength(1)
    expect(r.body.datanets['9'].stats).toHaveProperty('voteAlignmentPct')
    expect(r.body.proposals).toHaveLength(1)
  })
})

describe('POST /api/learn/proposals/:id', () => {
  it('accept applies the strictness change through the validated config writer', async () => {
    const id = insertProposal(dir, proposal())
    const r = await post(`/api/learn/proposals/${id}`, { decision: 'accept' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, status: 'accepted', appliesNextCycle: true })
    expect(JSON.parse(readConfigText(dir)!).datanets['9'].strictness).toBe('conservative')
    expect(readProposals(dir, { status: 'pending' })).toHaveLength(0)
  })

  it('rejects a stale proposal (config changed since) without clobbering the newer value', async () => {
    const id = insertProposal(dir, proposal()) // fromValue balanced
    writeConfig(dir, { ...baseConfig(), datanets: { '9': { vote: true, mint: true, strictness: 'aggressive' } } } as never)
    const r = await post(`/api/learn/proposals/${id}`, { decision: 'accept' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ ok: false, status: 'stale' })
    expect(JSON.parse(readConfigText(dir)!).datanets['9'].strictness).toBe('aggressive') // untouched
  })

  it('reject marks the proposal rejected and leaves config untouched', async () => {
    const id = insertProposal(dir, proposal())
    const r = await post(`/api/learn/proposals/${id}`, { decision: 'reject' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, status: 'rejected' })
    expect(JSON.parse(readConfigText(dir)!).datanets['9'].strictness).toBe('balanced')
    expect(readProposals(dir, { status: 'pending' })).toHaveLength(0)
  })

  it('409 for an unknown proposal id', async () => {
    const r = await post('/api/learn/proposals/999', { decision: 'accept' })
    expect(r.status).toBe(409)
    expect(r.body.ok).toBe(false)
  })
})

describe('POST /api/learn/disable and /api/learn/veto', () => {
  it('disable flips the per-datanet enabled flag (GET reflects it)', async () => {
    await post('/api/learn/disable', { datanetId: '9', enabled: false })
    expect((await get('/api/learn')).body.datanets['9'].enabled).toBe(false)
  })

  it('veto deactivates the datanet lessons', async () => {
    insertLesson(dir, lesson())
    await post('/api/learn/veto', { datanetId: '9' })
    expect((await get('/api/learn')).body.datanets['9'].lessons).toHaveLength(0)
  })
})
