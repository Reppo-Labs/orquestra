import { describe, it, expect } from 'vitest'
import { parseMarketChart } from './coingecko.js'

const D1 = Date.UTC(2026, 6, 6)   // 2026-07-06
const D2 = Date.UTC(2026, 6, 7)
const D2b = Date.UTC(2026, 6, 7, 14) // same UTC date, later timestamp

describe('parseMarketChart', () => {
  it('maps prices+volumes to daily points, keeping the LAST point per UTC date', () => {
    const raw = {
      prices: [[D1, 100.5], [D2, 101.0], [D2b, 101.7]],
      total_volumes: [[D1, 5_000_000], [D2, 6_000_000], [D2b, 6_500_000]],
    }
    const out = parseMarketChart(raw)
    expect(out).toEqual([
      { date: '2026-07-06', close: 100.5, volumeUsd: 5_000_000 },
      { date: '2026-07-07', close: 101.7, volumeUsd: 6_500_000 },
    ])
  })
  it('omits volumeUsd when volumes are missing or zero', () => {
    const out = parseMarketChart({ prices: [[D1, 100]], total_volumes: [[D1, 0]] })
    expect(out).toEqual([{ date: '2026-07-06', close: 100 }])
  })
  it('returns [] on malformed payloads', () => {
    expect(parseMarketChart(null)).toEqual([])
    expect(parseMarketChart({})).toEqual([])
    expect(parseMarketChart({ prices: 'nope' })).toEqual([])
    expect(parseMarketChart({ prices: [['bad', 'row']] })).toEqual([])
  })
})
