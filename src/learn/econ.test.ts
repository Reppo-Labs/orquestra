import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetDbs } from '../dashboard/db.js'
import { appendActivity, type ActivityEntry } from '../dashboard/activityLog.js'
import { readEconEpochs, getEconWatermark } from './store.js'
import { bucketEconomics, collectEconomics, VOTER_CLAIM_DETAIL, type EconEpochInfo } from './econ.js'

// Current-epoch window fixture: epoch 60 started at 2026-07-11T00:00Z, 1-day epochs.
// The default row ts sits INSIDE that window, so in-window rows bucket to 60.
const EPOCH_START = Date.parse('2026-07-11T00:00:00.000Z') / 1000
const E: EconEpochInfo = { epoch: 60, epochStart: EPOCH_START, epochDurationSeconds: 86_400 }
const IN_WINDOW_TS = '2026-07-11T12:00:00.000Z'

const row = (over: Partial<ActivityEntry> = {}): ActivityEntry & { id?: number } => ({
  ts: IN_WINDOW_TS, cycleId: 'c1', kind: 'vote', datanetId: 'd1', status: 'executed',
  ...over,
})

describe('bucketEconomics — pure', () => {
  it('ignores rows whose status is not executed', () => {
    const rows = [row({ kind: 'mint', reppoSpent: 100, status: 'refused-budget' })]
    expect(bucketEconomics(rows, new Map(), new Map(), E)).toEqual([])
  })

  it('owner claim (detail without "voter") attributes via the own-pod set and uses the row epoch', () => {
    const own = new Map([['d1', new Set(['p1'])]])
    const rows = [row({ kind: 'claim', podId: 'p1', epoch: 50, reppoClaimed: 30, detail: 'owner claim', datanetId: '' })]
    const buckets = bucketEconomics(rows, own, new Map(), E)
    expect(buckets).toEqual([{ datanetId: 'd1', epoch: 50, ownerClaimedReppo: 30, voterClaimedReppo: 0, mintCostReppo: 0, mintCount: 0, votesCast: 0 }])
  })

  it('voter claim (detail includes VOTER_CLAIM_DETAIL) attributes via voteDatanetByPodId and uses the row epoch', () => {
    const voteMap = new Map([['p2', 'd2']])
    const rows = [row({ kind: 'claim', podId: 'p2', epoch: 51, reppoClaimed: 5, detail: `${VOTER_CLAIM_DETAIL} · claimed`, datanetId: '' })]
    const buckets = bucketEconomics(rows, new Map(), voteMap, E)
    expect(buckets).toEqual([{ datanetId: 'd2', epoch: 51, ownerClaimedReppo: 0, voterClaimedReppo: 5, mintCostReppo: 0, mintCount: 0, votesCast: 0 }])
  })

  // Round-trip with the EXACT detail strings cycle.ts writes for claims (see
  // runCycle's claim recording): `'voter · ${detail}'`, 'voter emissions', and
  // owner claims whose detail is undefined. Guards the VOTER_CLAIM_DETAIL coupling.
  it('round-trip: cycle.ts claim detail strings discriminate voter vs owner', () => {
    const own = new Map([['d1', new Set(['p1'])]])
    const voteMap = new Map([['p2', 'd2']])
    const rows = [
      row({ kind: 'claim', podId: 'p2', epoch: 51, reppoClaimed: 5, detail: 'voter emissions', datanetId: '' }),
      row({ kind: 'claim', podId: 'p2', epoch: 51, reppoClaimed: 3, detail: 'voter · CLAIM_X', datanetId: '' }),
      row({ kind: 'claim', podId: 'p1', epoch: 51, reppoClaimed: 20, detail: undefined, datanetId: '' }),
    ]
    const buckets = bucketEconomics(rows, own, voteMap, E)
    const byDn = new Map(buckets.map((b) => [b.datanetId, b]))
    expect(byDn.get('d2')).toMatchObject({ epoch: 51, voterClaimedReppo: 8, ownerClaimedReppo: 0 })
    expect(byDn.get('d1')).toMatchObject({ epoch: 51, ownerClaimedReppo: 20, voterClaimedReppo: 0 })
  })

  it('unattributable owner claim falls into the "" bucket, not dropped', () => {
    const rows = [row({ kind: 'claim', podId: 'unknown', epoch: 50, reppoClaimed: 12, detail: 'owner claim', datanetId: '' })]
    const buckets = bucketEconomics(rows, new Map([['d1', new Set(['p1'])]]), new Map(), E)
    expect(buckets).toEqual([{ datanetId: '', epoch: 50, ownerClaimedReppo: 12, voterClaimedReppo: 0, mintCostReppo: 0, mintCount: 0, votesCast: 0 }])
  })

  it('unattributable voter claim (no matching vote row) falls into the "" bucket', () => {
    const rows = [row({ kind: 'claim', podId: 'unknown', epoch: 51, reppoClaimed: 7, detail: 'voter emissions', datanetId: '' })]
    const buckets = bucketEconomics(rows, new Map(), new Map(), E)
    expect(buckets).toEqual([{ datanetId: '', epoch: 51, ownerClaimedReppo: 0, voterClaimedReppo: 7, mintCostReppo: 0, mintCount: 0, votesCast: 0 }])
  })

  it('claim with no row epoch falls back to the ts-derived epoch', () => {
    const rows = [row({ kind: 'claim', podId: 'p1', reppoClaimed: 9, detail: 'owner claim', datanetId: '' })]
    const buckets = bucketEconomics(rows, new Map([['d1', new Set(['p1'])]]), new Map(), E)
    expect(buckets[0].epoch).toBe(60) // ts inside the current window
  })

  it('mint rows add mintCostReppo + mintCount, bucketed by their ts (default reppoSpent 0 when absent)', () => {
    const rows = [row({ kind: 'mint', datanetId: 'd1', reppoSpent: 100 }), row({ kind: 'mint', datanetId: 'd1' })]
    const buckets = bucketEconomics(rows, new Map(), new Map(), E)
    expect(buckets).toEqual([{ datanetId: 'd1', epoch: 60, ownerClaimedReppo: 0, voterClaimedReppo: 0, mintCostReppo: 100, mintCount: 2, votesCast: 0 }])
  })

  it('vote rows increment votesCast, bucketed by their ts (inside the current window → current epoch)', () => {
    const rows = [row({ kind: 'vote', datanetId: 'd1' }), row({ kind: 'vote', datanetId: 'd1' }), row({ kind: 'vote', datanetId: 'd1' })]
    const buckets = bucketEconomics(rows, new Map(), new Map(), E)
    expect(buckets).toEqual([{ datanetId: 'd1', epoch: 60, ownerClaimedReppo: 0, voterClaimedReppo: 0, mintCostReppo: 0, mintCount: 0, votesCast: 3 }])
  })

  it('a mint whose ts is one full duration before epochStart buckets to epoch-1 (late-collected backlog)', () => {
    const oldTs = new Date((EPOCH_START - 86_400) * 1000).toISOString() // exactly one epoch back
    const rows = [row({ kind: 'mint', datanetId: 'd1', reppoSpent: 50, ts: oldTs })]
    const buckets = bucketEconomics(rows, new Map(), new Map(), E)
    expect(buckets).toEqual([{ datanetId: 'd1', epoch: 59, ownerClaimedReppo: 0, voterClaimedReppo: 0, mintCostReppo: 50, mintCount: 1, votesCast: 0 }])
  })

  it('a vote two epochs back buckets to epoch-2; epoch never goes below 0', () => {
    const twoBack = new Date((EPOCH_START - 2 * 86_400 + 1) * 1000).toISOString()
    expect(bucketEconomics([row({ kind: 'vote', ts: twoBack })], new Map(), new Map(), E)[0].epoch).toBe(58)
    const ancient = row({ kind: 'vote', ts: '1970-01-02T00:00:00.000Z' })
    expect(bucketEconomics([ancient], new Map(), new Map(), E)[0].epoch).toBe(0)
  })

  it('invalid epoch duration (0) or unparseable ts falls back to the current epoch — never NaN buckets', () => {
    const zeroDur: EconEpochInfo = { ...E, epochDurationSeconds: 0 }
    const oldTs = new Date((EPOCH_START - 86_400) * 1000).toISOString()
    expect(bucketEconomics([row({ kind: 'mint', ts: oldTs, reppoSpent: 1 })], new Map(), new Map(), zeroDur)[0].epoch).toBe(60)
    expect(bucketEconomics([row({ kind: 'vote', ts: 'not-a-date' })], new Map(), new Map(), E)[0].epoch).toBe(60)
  })

  it('other kinds (skip, grant, stake, info) are ignored even when executed', () => {
    const rows = [
      row({ kind: 'skip' }), row({ kind: 'grant' }), row({ kind: 'stake' }), row({ kind: 'info' }),
    ]
    expect(bucketEconomics(rows, new Map(), new Map(), E)).toEqual([])
  })

  it('sums multiple rows across kinds into one bucket per (datanet, epoch)', () => {
    const own = new Map([['d1', new Set(['p1'])]])
    const rows = [
      row({ kind: 'vote', datanetId: 'd1' }),
      row({ kind: 'vote', datanetId: 'd1' }),
      row({ kind: 'mint', datanetId: 'd1', reppoSpent: 40 }),
      row({ kind: 'claim', podId: 'p1', epoch: 60, reppoClaimed: 10, detail: 'owner claim', datanetId: '' }),
    ]
    const buckets = bucketEconomics(rows, own, new Map(), E)
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
    const buckets = bucketEconomics(rows, own, voteMap, E).sort((a, b) => a.epoch - b.epoch)
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

    const processed = collectEconomics(dir, ownPods, E)
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

  it('a backlogged mint (older ts) collected late still lands in the epoch it happened in', () => {
    const oldTs = new Date((EPOCH_START - 86_400) * 1000).toISOString()
    appendActivity(dir, row({ kind: 'mint', datanetId: 'd1', reppoSpent: 70, ts: oldTs }))
    expect(collectEconomics(dir, ownPods, E)).toBe(1)
    const bucket = readEconEpochs(dir, 'd1').find((r) => r.epoch === 59)
    expect(bucket).toMatchObject({ mintCostReppo: 70, mintCount: 1 })
  })

  it('watermark idempotency: re-collecting the same rows processes 0 and leaves buckets unchanged', () => {
    appendActivity(dir, row({ kind: 'mint', datanetId: 'd1', reppoSpent: 100 }))
    expect(collectEconomics(dir, ownPods, E)).toBe(1)
    const before = readEconEpochs(dir, 'd1')

    expect(collectEconomics(dir, ownPods, E)).toBe(0)
    expect(readEconEpochs(dir, 'd1')).toEqual(before)
  })

  it('a later collect only processes newly-appended rows, additively', () => {
    appendActivity(dir, row({ kind: 'mint', datanetId: 'd1', reppoSpent: 100 }))
    expect(collectEconomics(dir, ownPods, E)).toBe(1)

    appendActivity(dir, row({ kind: 'mint', datanetId: 'd1', reppoSpent: 40 }))
    appendActivity(dir, row({ kind: 'vote', datanetId: 'd1' }))
    expect(collectEconomics(dir, ownPods, E)).toBe(2)

    const bucket = readEconEpochs(dir, 'd1').find((r) => r.epoch === 60)
    expect(bucket).toMatchObject({ mintCostReppo: 140, mintCount: 2, votesCast: 1 })
  })

  it('returns 0 and touches nothing when there are no activity rows at all', () => {
    expect(collectEconomics(dir, ownPods, E)).toBe(0)
    expect(getEconWatermark(dir)).toBe(0)
    expect(readEconEpochs(dir, 'd1')).toEqual([])
  })
})
