// src/reppo/readCache.test.ts
import { describe, it, expect } from 'vitest'
import { makeCachedReader } from './readCache.js'
import type { ReppoReader } from './reader.js'

/** Counting fake reader: every method resolves a distinct value and counts calls. */
function fakeReader(overrides: Partial<ReppoReader> = {}): { reader: ReppoReader; calls: Record<string, number> } {
  const calls: Record<string, number> = {}
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1 }
  const reader: ReppoReader = {
    listPods: async (d, o) => { count(`listPods|${d}|${o.all}`); return [] },
    datanetPodVotes: async () => { count('datanetPodVotes'); return [] },
    emissionsDue: async () => { count('emissionsDue'); return { totalReppo: 0, pods: [] } },
    balance: async () => { count('balance'); return { eth: 1, reppo: 2, veReppo: 3, usdc: 4 } },
    votingPower: async () => { count('votingPower'); return { power: 5, lockupCount: 1 } },
    epoch: async () => { count('epoch'); return { epoch: 7, epochStart: 0, epochDurationSeconds: 604800, secondsRemaining: 120 } },
    listDatanets: async () => { count('listDatanets'); return [] },
    subnetEmissionInfo: async () => { count('subnetEmissionInfo'); return {} as never },
    tokenBalance: async () => { count('tokenBalance'); return 0n },
    epochVoteVolume: async () => { count('epochVoteVolume'); return { epoch: 7, totalRaw: 0n } },
    votePowerBudget: async () => { count('votePowerBudget'); return {} as never },
    subnetPools: async () => { count('subnetPools'); return { reppoWei: 0n, primaryWei: 0n } },
    claimableOnchain: async () => { count('claimableOnchain'); return [] },
    voterClaimableOnchain: async () => { count('voterClaimableOnchain'); return [] },
    ...overrides,
  }
  return { reader, calls }
}

describe('tick-scoped memo', () => {
  it('serves repeated reads from the memo within a cycle, refetches after beginCycle', async () => {
    const { reader: inner, calls } = fakeReader()
    const c = makeCachedReader(inner)
    await c.reader.listPods('3', { all: true })
    await c.reader.listPods('3', { all: true })
    await c.reader.balance()
    await c.reader.balance()
    expect(calls['listPods|3|true']).toBe(1)
    expect(calls['balance']).toBe(1)
    c.beginCycle()
    await c.reader.listPods('3', { all: true })
    expect(calls['listPods|3|true']).toBe(2)
  })

  it('distinct arguments are distinct entries', async () => {
    const { reader: inner, calls } = fakeReader()
    const c = makeCachedReader(inner)
    await c.reader.listPods('3', { all: true })
    await c.reader.listPods('3', { all: false })
    await c.reader.listPods('4', { all: true })
    expect(calls['listPods|3|true']).toBe(1)
    expect(calls['listPods|3|false']).toBe(1)
    expect(calls['listPods|4|true']).toBe(1)
  })

  it('concurrent identical reads share ONE in-flight call', async () => {
    const { reader: inner, calls } = fakeReader()
    const c = makeCachedReader(inner)
    await Promise.all([c.reader.emissionsDue(), c.reader.emissionsDue(), c.reader.emissionsDue()])
    expect(calls['emissionsDue']).toBe(1)
  })
})

describe('TTL cache (listDatanets)', () => {
  it('serves from cache under the TTL and refetches after expiry', async () => {
    let t = 0
    const { reader: inner, calls } = fakeReader()
    const c = makeCachedReader(inner, { now: () => t })
    await c.reader.listDatanets()
    t += 9 * 60_000
    await c.reader.listDatanets()
    expect(calls['listDatanets']).toBe(1) // 9min < 10min TTL
    t += 2 * 60_000
    await c.reader.listDatanets()
    expect(calls['listDatanets']).toBe(2) // 11min > TTL → refetch
  })

  it('survives beginCycle (not tick-scoped)', async () => {
    const { reader: inner, calls } = fakeReader()
    const c = makeCachedReader(inner, { now: () => 0 })
    await c.reader.listDatanets()
    c.beginCycle()
    await c.reader.listDatanets()
    expect(calls['listDatanets']).toBe(1)
  })
})

describe('epoch-derived expiry', () => {
  it('caches epoch until its reported secondsRemaining elapse', async () => {
    let t = 0
    const { reader: inner, calls } = fakeReader() // secondsRemaining: 120
    const c = makeCachedReader(inner, { now: () => t })
    await c.reader.epoch()
    t += 100_000
    await c.reader.epoch()
    expect(calls['epoch']).toBe(1) // 100s < 120s remaining
    t += 30_000
    await c.reader.epoch()
    expect(calls['epoch']).toBe(2) // 130s > 120s → epoch may have rolled → refetch
  })

  it('floors the expiry so a skewed 0-seconds-remaining cannot thrash on every read', async () => {
    let t = 0
    const { reader: inner, calls } = fakeReader({
      epoch: async () => {
        calls['epoch'] = (calls['epoch'] ?? 0) + 1
        return { epoch: 7, epochStart: 0, epochDurationSeconds: 604800, secondsRemaining: 0 }
      },
    })
    const c = makeCachedReader(inner, { now: () => t })
    await c.reader.epoch()
    t += 10_000
    await c.reader.epoch()
    expect(calls['epoch']).toBe(1) // 10s < 30s floor → still cached
  })
})

describe('write-triggered invalidation', () => {
  it('invalidateTags evicts only matching entries', async () => {
    const { reader: inner, calls } = fakeReader()
    const c = makeCachedReader(inner)
    await c.reader.epochVoteVolume('rpc', ['1'])
    await c.reader.balance()
    await c.reader.listPods('3', { all: true })
    c.invalidateTags(['votes', 'balance']) // a vote executed
    await c.reader.epochVoteVolume('rpc', ['1'])
    await c.reader.balance()
    await c.reader.listPods('3', { all: true })
    expect(calls['epochVoteVolume']).toBe(2) // evicted
    expect(calls['balance']).toBe(2) // evicted
    expect(calls['listPods|3|true']).toBe(1) // pods untouched by a vote
  })

  it('claim invalidates emissions reads', async () => {
    const { reader: inner, calls } = fakeReader()
    const c = makeCachedReader(inner)
    await c.reader.emissionsDue()
    await c.reader.subnetPools('rpc', '3')
    c.invalidateTags(['emissions', 'balance'])
    await c.reader.emissionsDue()
    await c.reader.subnetPools('rpc', '3')
    expect(calls['emissionsDue']).toBe(2)
    expect(calls['subnetPools']).toBe(2)
  })
})

describe('failure handling', () => {
  it('a rejected read is not cached — the next read retries', async () => {
    let fail = true
    const calls = { balance: 0 }
    const { reader: inner } = fakeReader({
      balance: async () => {
        calls.balance++
        if (fail) throw new Error('rpc down')
        return { eth: 1, reppo: 2, veReppo: 3, usdc: 4 }
      },
    })
    const c = makeCachedReader(inner)
    await expect(c.reader.balance()).rejects.toThrow('rpc down')
    fail = false
    await expect(c.reader.balance()).resolves.toBeTruthy()
    expect(calls.balance).toBe(2)
  })
})
