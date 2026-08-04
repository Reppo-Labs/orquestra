import { describe, it, expect } from 'vitest'
import { compareSeries, type TokenDailyPoint, type DailyPoint } from './compare.js'

// Equity fixture: AAPL trades Mon 07-06 .. Fri 07-10, then Mon 07-13 (weekend gap).
const ref: DailyPoint[] = [
  { date: '2026-07-06', close: 100 },
  { date: '2026-07-07', close: 102 },
  { date: '2026-07-08', close: 101 },
  { date: '2026-07-09', close: 103 },
  { date: '2026-07-10', close: 104 },
  { date: '2026-07-13', close: 106 },
]
// Token trades 24/7 (has weekend points the reference lacks).
const token: TokenDailyPoint[] = [
  { date: '2026-07-06', close: 101, volumeUsd: 1_000_000 },      // gap +1.00%
  { date: '2026-07-07', close: 102.51, volumeUsd: 1_000_000 },   // gap +0.50%
  { date: '2026-07-08', close: 100.495, volumeUsd: 1_000_000 },  // gap −0.50%
  { date: '2026-07-09', close: 103, volumeUsd: 1_000_000 },      // gap 0
  { date: '2026-07-10', close: 104.52, volumeUsd: 1_000_000 },   // gap +0.50%
  { date: '2026-07-11', close: 105, volumeUsd: 1_000_000 },      // weekend — no ref
  { date: '2026-07-12', close: 105.5, volumeUsd: 1_000_000 },    // weekend — no ref
  { date: '2026-07-13', close: 105.47, volumeUsd: 1_000_000 },   // gap −0.50%
]

describe('compareSeries', () => {
  it('computes golden stats on the equity fixture', () => {
    const s = compareSeries(token, ref, 'equity')
    expect(s).not.toBeNull()
    expect(s!.tradingDaysCompared).toBe(6)              // weekend points dropped
    expect(s!.avgTrackingGapPct).toBeCloseTo(0.5, 5)    // (1+.5+.5+0+.5+.5)/6
    expect(s!.maxDeviationPct).toBeCloseTo(1.0, 5)
    expect(s!.maxDeviationDate).toBe('2026-07-06')
    expect(s!.avgDailyTokenVolumeUsd).toBe(1_000_000)
    // Fri 07-10 → Mon 07-13 spans a >1-day calendar gap:
    // |105.47 − 104.52| / 104.52 × 100 = 0.90892…
    expect(s!.closedMarketDriftPct).toBeCloseTo(0.90892, 4)
  })

  it('metal class never reports closed-market drift', () => {
    const s = compareSeries(token, ref, 'metal')
    expect(s!.closedMarketDriftPct).toBeNull()
  })

  it('returns null under 3 shared days', () => {
    expect(compareSeries(token.slice(0, 2), ref.slice(0, 2), 'metal')).toBeNull()     // 2 shared days
    expect(compareSeries(token.slice(0, 2), ref.slice(0, 1), 'metal')).toBeNull()     // 1 shared day
    expect(compareSeries([], ref, 'metal')).toBeNull()
  })

  it('volume null when no volume data present', () => {
    const noVol = token.map(({ volumeUsd: _v, ...rest }) => rest)
    const s = compareSeries(noVol, ref, 'equity')
    expect(s!.avgDailyTokenVolumeUsd).toBeNull()
  })
})
