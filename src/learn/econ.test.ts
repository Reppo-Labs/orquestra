import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetDbs } from '../dashboard/db.js'
import { appendActivity, type ActivityEntry } from '../dashboard/activityLog.js'
import { readEconEpochs, getEconWatermark } from './store.js'
import { bucketEconomics, collectEconomics } from './econ.js'

const row = (over: Partial<ActivityEntry> = {}): ActivityEntry & { id?: number } => ({
  ts: '2026-07-11T00:00:00.000Z', cycleId: 'c1', kind: 'vote', datanetId: 'd1', status: 'executed',
  ...over,
})

describe('bucketEconomics — pure', () => {
  it('ignores rows whose status is not executed', () => {
    const rows = [row({ kind: 'mint', reppoSpent: 100, status: 'refused-budget' })]
    expect(bucketEconomics(rows, new Map(), new Map(), 60)).toEqual([])
  })

  it('owner claim (detail without "voter") attributes via the own-pod set and uses the row epoch', () => {
    const own = new Map([['d1', new Set(['p1'])]])
    const rows = [row({ kind: 'claim', podId: 'p1', epoch: 50, reppoClaimed: 30, detail: 'owner claim', datanetId: '' })]
    const buckets = bucketEconomics(rows, own, new Map(), 60)
    expect(buckets).toEqual([{ datanetId: 'd1', epoch: 50, ownerClaimedReppo: 30, voterClaimedReppo: 0, mintCostReppo: 0, mintCount: 0, votesCast: 0 }])
  })

  it('voter claim (detail includes "voter") attributes via voteDatanetByPodId and uses the row epoch', () => {
    const voteMap = new Map([['p2', 'd2']])
    const rows = [row({ kind: 'claim', podId: 'p2', epoch: 51, reppoClaimed: 5, detail: 'voter · claimed', datanetId: '' })]
    const buckets = bucketEconomics(rows, new Map(), voteMap, 60)
    expect(buckets).toEqual([{ datanetId: 'd2', epoch: 51, ownerClaimedReppo: 0, voterClaimedReppo: 5, mintCostReppo: 0, mintCount: 0, votesCast: 0 }])
  })

  it('unattributable owner claim falls into the "" bucket, not dropped', () => {
    const rows = [row({ kind: 'claim', podId: 'unknown', epoch: 50, reppoClaimed: 12, detail: 'owner claim', datanetId: '' })]
    const buckets = bucketEconomics(rows, new Map([['d1', new Set(['p1'])]]), new Map(), 60)
    expect(buckets).toEqual([{ datanetId: '', epoch: 50, ownerClaimedReppo: 12, voterClaimedReppo: 0, mintCostReppo: 0, mintCount: 0, votesCast: 0 }])
  })

  it('unattributable voter claim (no matching vote row) falls into the "" bucket', () => {
    const rows = [row({ kind: 'claim', podId: 'unknown', epoch: 51, reppoClaimed: 7, detail: 'voter emissions', datanetId: '' })]
    const buckets = bucketEconomics(rows, new Map(), new Map(), 60)
    expect(buckets).toEqual([{ datanetId: '', epoch: 51, ownerClaimedReppo: 0, voterClaimedReppo: 7, mintCostReppo: 0, mintCount: 0, votesCast: 0 }])
  })

  it('claim with no row epoch falls back to currentEpoch', () => {
    const rows = [row({ kind: 'claim', podId: 'p1', reppoClaimed: 9, detail: 'owner claim', datanetId: '' })]
    const buckets = bucketEconomics(rows, new Map([['d1', new Set(['p1'])]]), new Map(), 60)
    expect(buckets[0].epoch).toBe(60)
  })

  it('mint rows add mintCostReppo + mintCount, bucketed to currentEpoch (default reppoSpent 0 when absent)', () => {
    const rows = [row({ kind: 'mint', datanetId: 'd1', reppoSpent: 100 }), row({ kind: 'mint', datanetId: 'd1' })]
    const buckets = bucketEconomics(rows, new Map(), new Map(), 60)
    expect(buckets).toEqual([{ datanetId: 'd1', epoch: 60, ownerClaimedReppo: 0, voterClaimedReppo: 0, mintCostReppo: 100, mintCount: 2, votesCast: 0 }])
  })

  it('vote rows increment votesCast, bucketed to currentEpoch', () => {
    const rows = [row({ kind: 'vote', datanetId: 'd1' }), row({ kind: 'vote', datanetId: 'd1' }), row({ kind: 'vote', datanetId: 'd1' })]
    const buckets = bucketEconomics(rows, new Map(), new Map(), 60)
    expect(buckets).toEqual([{ datanetId: 'd1', epoch: 60, ownerClaimedReppo: 0, voterClaimedReppo: 0, mintCostReppo: 0, mintCount: 0, votesCast: 3 }])
  })

  it('other kinds (skip, grant, stake, info) are ignored even when executed', () => {
    const rows = [
      row({ kind: 'skip' }), row({ kind: 'grant' }), row({ kind: 'stake' }), row({ kind: 'info' }),
    ]
    expect(bucketEconomics(rows, new Map(), new Map(), 60)).toEqual([])
  })

  it('sums multiple rows across kinds into one bucket per (datanet, epoch)', () => {
    const own = new Map([['d1', new Set(['p1'])]])
    const rows = [
      row({ kind: 'vote', datanetId: 'd1' }),
      row({ kind: 'vote', datanetId: 'd1' }),
      row({ kind: 'mint', datanetId: 'd1', reppoSpent: 40 }),
      row({ kind: 'claim', podId: 'p1', epoch: 60, reppoClaimed: 10, detail: 'owner claim', datanetId: '' }),
    ]
    const buckets = bucketEconomics(rows, own, new Map(), 60)
    expect(buckets).toEqual([{ datanetId: 'd1', epoch: 60, ownerClaimedReppo: 10, voterClaimedReppo: 0, mintCostReppo: 40, mintCount: 1, votesCast: 2 }])
  })

  it('separates buckets across different (datanet, epoch) pairs', () => {
    const own = new Map([['d1', new Set(['p1'])]])
    const voteMap = new Map([['p2', 'd2']])
    const rows = [
      row({ kind: 'vote', datanetId: 'd1' }),
      row({ kind: 'claim', podId: 'p1', epoch: 50, reppoClaimed: 30, detail: 'owner claim', datanetId: '' }),
      row({ kind: 'claim', podId: 'p2', epoch: 51, reppoClaimed: 5, detail: 'voter · claimed', datanetId: '' }),
    ]
    const buckets = bucketEconomics(rows, own, voteMap, 60).sort((a, b) => a.epoch - b.epoch)
    expect(buckets).toHaveLength(3)
    expect(buckets.map((b) => `${b.datanetId}@${b.epoch}`)).toEqual(['d1@50', 'd2@51', 'd1@60'])
  })
})

describe('collectEconomics — IO against a real temp-dir DB', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-econ-')) })
  afterEach(() => { _resetDbs(); rmSync(dir, { recursive: true, force: true }) })

  const ownPods = new Map([['d1', new Set(['p1'])]])

  it('collects owner claim, voter claim, mint, and vote rows into their econ buckets', () => {
    appendActivity(dir, row({ kind: 'vote', datanetId: 'd1', podId: 'p1' }))
    appendActivity(dir, row({ kind: 'vote', datanetId: 'd2', podId: 'p2' }))
    appendActivity(dir, row({ kind: 'mint', datanetId: 'd1', reppoSpent: 100 }))
    appendActivity(dir, row({ kind: 'claim', podId: 'p1', epoch: 50, reppoClaimed: 30, detail: 'owner claim', datanetId: '' }))
    appendActivity(dir, row({ kind: 'claim', podId: 'p2', epoch: 51, reppoClaimed: 5, detail: 'voter · claimed', datanetId: '' }))

    const processed = collectEconomics(dir, ownPods, 60)
    expect(processed).toBe(5)

    const d1 = readEconEpochs(dir, 'd1')
    const byEpoch = new Map(d1.map((r) => [r.epoch, r]))
    expect(byEpoch.get(60)).toMatchObject({ mintCostReppo: 100, mintCount: 1, votesCast: 1 })
    expect(byEpoch.get(50)).toMatchObject({ ownerClaimedReppo: 30 })

    const d2 = readEconEpochs(dir, 'd2')
    const d2ByEpoch = new Map(d2.map((r) => [r.epoch, r]))
    expect(d2ByEpoch.get(60)).toMatchObject({ votesCast: 1 })
    expect(d2ByEpoch.get(51)).toMatchObject({ voterClaimedReppo: 5 })

    expect(getEconWatermark(dir)).toBeGreaterThan(0)
  })

  it('watermark idempotency: re-collecting the same rows processes 0 and leaves buckets unchanged', () => {
    appendActivity(dir, row({ kind: 'mint', datanetId: 'd1', reppoSpent: 100 }))
    expect(collectEconomics(dir, ownPods, 60)).toBe(1)
    const before = readEconEpochs(dir, 'd1')

    expect(collectEconomics(dir, ownPods, 60)).toBe(0)
    expect(readEconEpochs(dir, 'd1')).toEqual(before)
  })

  it('a later collect only processes newly-appended rows, additively', () => {
    appendActivity(dir, row({ kind: 'mint', datanetId: 'd1', reppoSpent: 100 }))
    expect(collectEconomics(dir, ownPods, 60)).toBe(1)

    appendActivity(dir, row({ kind: 'mint', datanetId: 'd1', reppoSpent: 40 }))
    appendActivity(dir, row({ kind: 'vote', datanetId: 'd1' }))
    expect(collectEconomics(dir, ownPods, 60)).toBe(2)

    const bucket = readEconEpochs(dir, 'd1').find((r) => r.epoch === 60)
    expect(bucket).toMatchObject({ mintCostReppo: 140, mintCount: 2, votesCast: 1 })
  })

  it('returns 0 and touches nothing when there are no activity rows at all', () => {
    expect(collectEconomics(dir, ownPods, 60)).toBe(0)
    expect(getEconWatermark(dir)).toBe(0)
    expect(readEconEpochs(dir, 'd1')).toEqual([])
  })
})
