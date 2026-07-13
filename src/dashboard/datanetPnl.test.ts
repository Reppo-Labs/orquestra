// src/dashboard/datanetPnl.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeDatanetPnl, readDatanetPnl } from './datanetPnl.js'
import { appendActivity, type ActivityEntry } from './activityLog.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-dpnl-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const entry = (e: Partial<ActivityEntry>): ActivityEntry =>
  ({ ts: new Date().toISOString(), cycleId: 'c1', kind: 'vote', datanetId: '9', status: 'executed', ...e }) as ActivityEntry

describe('computeDatanetPnl (pure)', () => {
  it('derives net + roi from spend and earnings', () => {
    const [d] = computeDatanetPnl([{ datanetId: '2', reppoSpent: 400, reppoEarned: 821.91, votesCast: 3, mintsExecuted: 2 }])
    expect(d.net).toBeCloseTo(421.91)
    expect(d.roi).toBe(205) // the "Datanet 2 returned 205%" an operator acts on
  })

  it('roi is NULL (not 0) when nothing was spent — a vote-only datanet has no return ratio', () => {
    const [d] = computeDatanetPnl([{ datanetId: '1', reppoSpent: 0, reppoEarned: 0, votesCast: 10, mintsExecuted: 0 }])
    expect(d.roi).toBeNull()
    expect(d.net).toBe(0)
    expect(d.votesCast).toBe(10)
  })

  it('a zero-spend datanet that earned voter emissions shows positive net with a null roi', () => {
    const [d] = computeDatanetPnl([{ datanetId: '5', reppoSpent: 0, reppoEarned: 12.5, votesCast: 4, mintsExecuted: 0 }])
    expect(d.roi).toBeNull()
    expect(d.net).toBe(12.5)
  })

  it('sorts worst-net first (the datanet an operator should look at)', () => {
    const rows = computeDatanetPnl([
      { datanetId: '2', reppoSpent: 400, reppoEarned: 821.91, votesCast: 3, mintsExecuted: 2 },
      { datanetId: '1', reppoSpent: 200, reppoEarned: 0, votesCast: 10, mintsExecuted: 1 },
    ])
    expect(rows.map((r) => r.datanetId)).toEqual(['1', '2'])
    expect(rows[0].net).toBe(-200)
    expect(rows[0].roi).toBe(0) // spent 200, earned nothing → a REAL 0%, not null
  })
})

describe('readDatanetPnl (over the activity log)', () => {
  it('sums executed mint spend and claim earnings per datanet, counting votes and mints', () => {
    appendActivity(dir, entry({ datanetId: '2', kind: 'mint', reppoSpent: 200, canonicalKey: 'k1' }))
    appendActivity(dir, entry({ datanetId: '2', kind: 'mint', reppoSpent: 200, canonicalKey: 'k2' }))
    appendActivity(dir, entry({ datanetId: '2', kind: 'claim', reppoClaimed: 821.91, podId: 'p1', epoch: 3 }))
    appendActivity(dir, entry({ datanetId: '2', kind: 'vote', podId: 'p9' }))
    appendActivity(dir, entry({ datanetId: '1', kind: 'vote', podId: 'p2' }))

    const rows = readDatanetPnl(dir)
    const d2 = rows.find((r) => r.datanetId === '2')!
    expect(d2).toMatchObject({ reppoSpent: 400, votesCast: 1, mintsExecuted: 2, roi: 205 })
    expect(d2.reppoEarned).toBeCloseTo(821.91)

    const d1 = rows.find((r) => r.datanetId === '1')!
    expect(d1).toMatchObject({ reppoSpent: 0, reppoEarned: 0, roi: null, votesCast: 1, mintsExecuted: 0 })
  })

  it('ignores non-executed rows — a refused or errored mint costs nothing', () => {
    appendActivity(dir, entry({ datanetId: '3', kind: 'mint', reppoSpent: 200, status: 'refused-budget' }))
    appendActivity(dir, entry({ datanetId: '3', kind: 'mint', reppoSpent: 200, status: 'error' }))
    appendActivity(dir, entry({ datanetId: '3', kind: 'vote', status: 'error' }))
    const [d] = readDatanetPnl(dir)
    expect(d).toMatchObject({ datanetId: '3', reppoSpent: 0, votesCast: 0, mintsExecuted: 0, roi: null })
  })

  it('excludes wallet-global rows that carry no datanetId (veREPPO stake breadcrumbs)', () => {
    appendActivity(dir, entry({ datanetId: '', kind: 'stake', reason: 'topped up veREPPO' }))
    appendActivity(dir, entry({ datanetId: '9', kind: 'vote' }))
    expect(readDatanetPnl(dir).map((r) => r.datanetId)).toEqual(['9'])
  })

  it('is empty on a fresh node', () => {
    expect(readDatanetPnl(dir)).toEqual([])
  })
})
