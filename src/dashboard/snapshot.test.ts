import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSnapshot, readSnapshot, collectSnapshot, type Snapshot } from './snapshot.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-snap-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  ts: '2026-06-03T21:38:40.000Z', cycleId: 'c1',
  balance: { eth: 0.4, reppo: 1850, veReppo: 500, usdc: 0 },
  votingPower: { power: 500, lockupCount: 1 },
  emissionsDue: { totalReppo: 0, pods: [] },
  budget: { mintReppoSpent: 100, mintGasSpentEth: 0.003, voteGasSpentEth: 0.001, claimGasSpentEth: 0.0007,
    caps: { voteGasEthMax: 0.05, voteRateMaxPerCycle: 30, mintReppoMax: 500, mintGasEthMax: 0.05, claimGasEthMax: 0.05 } },
  ...over,
})

describe('snapshot', () => {
  it('write then read round-trips', () => {
    writeSnapshot(dir, snap())
    expect(readSnapshot(dir)?.balance.reppo).toBe(1850)
  })

  it('readSnapshot returns null when absent', () => {
    expect(readSnapshot(dir)).toBeNull()
  })

  it('keeps history and reads the latest write', () => {
    writeSnapshot(dir, snap({ ts: '2026-06-03T21:38:40.000Z', balance: { eth: 1, reppo: 1, veReppo: 1, usdc: 1 } }))
    writeSnapshot(dir, snap({ ts: '2026-06-04T21:38:40.000Z', balance: { eth: 2, reppo: 2, veReppo: 2, usdc: 2 } }))
    expect(readSnapshot(dir)?.balance.reppo).toBe(2)
    expect(readSnapshot(dir)?.ts).toBe('2026-06-04T21:38:40.000Z')
  })

  it('imports a legacy snapshot.json once, then renames it .imported', () => {
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snap()))
    expect(readSnapshot(dir)?.balance.reppo).toBe(1850)               // first read triggers import
    expect(existsSync(join(dir, 'snapshot.json'))).toBe(false)
    expect(existsSync(join(dir, 'snapshot.json.imported'))).toBe(true)
  })

  it('collectSnapshot merges over the last snapshot when a sub-call fails', async () => {
    writeSnapshot(dir, snap({ balance: { eth: 9, reppo: 9, veReppo: 9, usdc: 9 } }))
    const result = await collectSnapshot(dir, 'c2', {
      balance: async () => { throw new Error('rpc') },          // fails → keep prior 9s
      votingPower: async () => ({ power: 600, lockupCount: 2 }),
      emissionsDue: async () => ({ totalReppo: 0, pods: [] }),
      epoch: async () => ({ epoch: 97, epochStart: 1780493161, epochDurationSeconds: 172800, secondsRemaining: 72636 }),
      budget: () => snap().budget,
    })
    expect(result.balance.reppo).toBe(9)        // retained from prior snapshot
    expect(result.votingPower.power).toBe(600)  // fresh
    expect(result.cycleId).toBe('c2')
  })
})
