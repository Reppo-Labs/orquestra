import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDashboard, type DashboardHandle } from './server.js'
import { appendActivity } from './activityLog.js'

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
  it('/api/config strips secrets', async () => {
    const r = await get('/api/config')
    expect(r.status).toBe(200)
    expect(r.body).not.toMatch(/PRIVATE_KEY|inf_|0x[a-fA-F0-9]{64}/)
    expect(JSON.parse(r.body)).toHaveProperty('cadenceHours')
  })
  it('unknown path → 404', async () => {
    expect((await get('/nope')).status).toBe(404)
  })
})
