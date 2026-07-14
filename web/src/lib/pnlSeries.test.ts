import { describe, expect, it } from 'vitest'
import { buildNetSeries, lossAcceleration } from './pnlSeries'
import type { ActivityRow, Pnl } from '../api'

// The property that matters: the chart must never contradict the verdict above it, and it
// must never invent history it cannot see. /api/activity is a CAPPED window (the server
// hard-codes limit 500), so a naive cumulative sum from zero would draw a loss that never
// happened.

/** Builds a Pnl the way the BACKEND does (src/dashboard/pnl.ts): earned = claimed + claimable,
 *  net = earned − spent. Passing a bare `netReppo` would let a test assert an anchor the real
 *  payload can never produce. */
const pnl = (over: Partial<Pnl> & { claimedReppo?: number; claimableReppo?: number; spentReppo?: number } = {}): Pnl => {
  const claimedReppo = over.claimedReppo ?? 0
  const claimableReppo = over.claimableReppo ?? 0
  const spentReppo = over.spentReppo ?? 0
  const earnedReppo = claimedReppo + claimableReppo
  return {
    claimedReppo, claimableReppo, spentReppo, earnedReppo,
    netReppo: earnedReppo - spentReppo,
    gasSpentEth: 0,
    ...over,
  }
}

/** Realized net = claimed − spent. The old tests said `netReppo: -1000`; they now say what
 *  produced it, because the difference between the two is the entire bug. */
const realized = (claimedReppo: number, spentReppo: number, claimableReppo = 0): Pnl =>
  pnl({ claimedReppo, spentReppo, claimableReppo })

const T0 = Date.parse('2026-07-01T00:00:00.000Z')
const day = (n: number): string => new Date(T0 + n * 86_400_000).toISOString()

const mint = (d: number, reppoSpent: number): ActivityRow =>
  ({ ts: day(d), kind: 'mint', status: 'executed', reppoSpent })
const claim = (d: number, reppoClaimed: number): ActivityRow =>
  ({ ts: day(d), kind: 'claim', status: 'executed', reppoClaimed })

describe('buildNetSeries — anchoring to the authoritative total', () => {
  it('ends at the LIFETIME net, not at a sum of the visible window', () => {
    // The window shows 300 spent / 100 earned, but the lifetime net is -1,000: older mints
    // were truncated out of the log. Summing the window from zero would claim -200 — a lie.
    const s = buildNetSeries([claim(3, 100), mint(2, 300)], realized(100, 1100))!
    expect(s.points[s.points.length - 1].net).toBe(-1000)
    expect(s.current).toBe(-1000)
    // ...and the window's own start sits BEHIND that, never at zero. `first` is the level
    // AFTER the window's first event (the 300 mint): -1000 − (+100) = -1100.
    expect(s.first).toBe(-1100)
    // `baseline` is the level BEFORE it: -1100 − (−300) = -800. The node did not start here
    // at zero, and the chart must never imply it did.
    expect(s.baseline).toBe(-800)
  })

  it('walks every point back through the deltas, so each level is exact', () => {
    // -500 now; the last claim added 100 → it was -600 before that; a 200 mint preceded it.
    const s = buildNetSeries([mint(1, 200), claim(2, 100)], realized(100, 600))!
    expect(s.points.map((p) => p.net)).toEqual([-600, -500])
  })

  it('orders points oldest → newest whatever the log order (the server sends newest-first)', () => {
    const s = buildNetSeries([claim(5, 10), mint(1, 20), claim(3, 5)], realized(15, 115))!
    expect(s.points.map((p) => p.t)).toEqual([Date.parse(day(1)), Date.parse(day(3)), Date.parse(day(5))])
  })

  it('mirrors the backend sum: only EXECUTED mints and claims move the line', () => {
    const rows: ActivityRow[] = [
      mint(1, 100),
      { ts: day(2), kind: 'mint', status: 'refused', reppoSpent: 9999 }, // never signed
      { ts: day(3), kind: 'vote', status: 'executed', gasEth: 0.001 }, // gas is ETH, not REPPO
      { ts: day(4), kind: 'skip', status: 'skipped' },
      claim(5, 40),
    ]
    const s = buildNetSeries(rows, realized(40, 100))!
    expect(s.events).toBe(2)
    expect(s.points.map((p) => p.net)).toEqual([-100, -60])
  })
})

describe('buildNetSeries — UNCLAIMED emissions must never bend the curve', () => {
  it('anchors on REALIZED money, so a node that has claimed nothing is never drawn in profit', () => {
    // Three mints of 200 (spent 600), zero claims ever, 900 REPPO of emissions pending.
    // The backend's netReppo is (0 + 900) − 600 = +300, and anchoring to it plots +700, +500,
    // +300 — every point above zero, the whole history filled GREEN, "up 300 overall". The
    // node has never claimed a single REPPO; at its first mint it was down 200, not up 700.
    const rows = [mint(1, 200), mint(2, 200), mint(3, 200)]
    const p = pnl({ claimedReppo: 0, claimableReppo: 900, spentReppo: 600 })
    expect(p.netReppo).toBe(300) // the payload really does say this

    const s = buildNetSeries(rows, p)!
    expect(s.current).toBe(-600)
    expect(s.points.map((x) => x.net)).toEqual([-200, -400, -600])
    expect(s.points.every((x) => x.net < 0)).toBe(true) // nothing is drawn above zero
  })

  it('reports the unclaimed balance separately, and says it is not counted', () => {
    const s = buildNetSeries([mint(1, 200), mint(2, 200)], pnl({ claimableReppo: 900, spentReppo: 400 }))!
    expect(s.claimable).toBe(900)
    expect(s.summary).toMatch(/due but not yet claimed, and is not counted above/i)
    expect(s.summary).toMatch(/down 400 REPPO overall/i)
  })

  it('does not mention money it is not owed', () => {
    expect(buildNetSeries([mint(1, 100), mint(2, 100)], realized(0, 200))!.claimable).toBe(0)
    expect(buildNetSeries([mint(1, 100), mint(2, 100)], realized(0, 200))!.summary).not.toMatch(/not yet claimed/i)
  })

  it('keeps lossAcceleration on the realized curve too', () => {
    // Same shape as the accelerating case, but with a large pending balance that would have
    // lifted every level (and the earlier/recent rates are measured off those levels).
    const rows = [mint(0, 10), mint(1, 10), mint(3, 400), mint(4, 400)]
    const a = lossAcceleration(buildNetSeries(rows, pnl({ claimableReppo: 5000, spentReppo: 1000 })))!
    expect(a.accelerating).toBe(true) // the node IS bleeding, whatever it is owed
  })
})

describe('buildNetSeries — insufficient data must not draw a line', () => {
  it('reports EMPTY history with no points at all', () => {
    const s = buildNetSeries([], realized(0, 0))!
    expect(s.insufficient).toBe(true)
    expect(s.points).toEqual([])
    expect(s.summary).toMatch(/no mints or claims yet/i)
  })

  it('refuses to draw a trend from a SINGLE money event', () => {
    const s = buildNetSeries([mint(1, 100)], realized(0, 100))!
    expect(s.insufficient).toBe(true)
    expect(s.points).toEqual([])
    expect(s.summary).toMatch(/not enough history/i)
    // The value itself is still known, and must still be shown.
    expect(s.current).toBe(-100)
  })

  it('treats an activity log with no MONEY events as empty, however busy it looks', () => {
    const busy: ActivityRow[] = [
      { ts: day(1), kind: 'vote', status: 'executed' },
      { ts: day(2), kind: 'skip', status: 'skipped' },
    ]
    expect(buildNetSeries(busy, realized(0, 0))!.insufficient).toBe(true)
  })

  it('returns null with no authoritative anchor — every level would be a guess', () => {
    expect(buildNetSeries([mint(1, 10), claim(2, 5)], null)).toBeNull()
  })
})

describe('buildNetSeries — trend and honesty flags', () => {
  it('calls a deepening loss "worsening"', () => {
    const s = buildNetSeries([mint(1, 100), mint(2, 100)], realized(0, 200))!
    expect(s.trend).toBe('worsening')
    expect(s.change).toBeLessThan(0)
    expect(s.summary).toMatch(/falling/i)
  })

  it('calls a recovering loss "improving" — while still owning the level', () => {
    const s = buildNetSeries([claim(1, 50), claim(2, 50)], realized(100, 200))!
    expect(s.trend).toBe('improving')
    expect(s.summary).toMatch(/recovering/i)
    expect(s.summary).toMatch(/down 100 REPPO overall/i) // recovering, but still down
  })

  it('flags a capped window so the UI cannot claim "all time"', () => {
    const many = Array.from({ length: 500 }, (_, i) => mint(i / 100, 1))
    expect(buildNetSeries(many, realized(0, 500))!.windowed).toBe(true)
    expect(buildNetSeries([mint(1, 1), mint(2, 1)], realized(0, 2))!.windowed).toBe(false)
  })
})

describe('lossAcceleration', () => {
  it('detects a loss that is speeding up', () => {
    // Days 0–1: slow bleed. Days 3–4: heavy spend.
    const rows = [mint(0, 10), mint(1, 10), mint(3, 400), mint(4, 400)]
    const a = lossAcceleration(buildNetSeries(rows, realized(0, 1000)))!
    expect(a.accelerating).toBe(true)
    expect(a.recentPerDay).toBeLessThan(a.earlierPerDay)
  })

  it('does NOT call a steady loss an accelerating one', () => {
    const rows = [mint(0, 100), mint(1, 100), mint(2, 100), mint(3, 100)]
    expect(lossAcceleration(buildNetSeries(rows, realized(0, 400)))!.accelerating).toBe(false)
  })

  it('never fires on a PROFITABLE node, however much its gains slowed', () => {
    const rows = [claim(0, 500), claim(1, 500), claim(3, 1), claim(4, 1)]
    const a = lossAcceleration(buildNetSeries(rows, realized(1002, 0)))!
    expect(a.accelerating).toBe(false) // slowing gains are not "bleeding faster"
  })

  it('counts a swing from gaining to losing as acceleration', () => {
    const rows = [claim(0, 100), claim(1, 100), mint(3, 300), mint(4, 300)]
    expect(lossAcceleration(buildNetSeries(rows, realized(200, 600)))!.accelerating).toBe(true)
  })

  it('declines to judge when there is too little to judge', () => {
    expect(lossAcceleration(null)).toBeNull()
    expect(lossAcceleration(buildNetSeries([mint(1, 10)], realized(0, 10)))).toBeNull()
    // 3 events: one half of the window would be a single point.
    expect(lossAcceleration(buildNetSeries([mint(0, 1), mint(1, 1), mint(2, 1)], realized(0, 3)))).toBeNull()
  })
})
