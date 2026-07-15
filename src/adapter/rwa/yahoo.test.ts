import { describe, it, expect } from 'vitest'
import { parseYahooChart } from './yahoo.js'

const T1 = Math.floor(Date.UTC(2026, 6, 6, 13, 30) / 1000)   // 2026-07-06 (intraday ts)
const T2 = Math.floor(Date.UTC(2026, 6, 7, 13, 30) / 1000)
const T3 = Math.floor(Date.UTC(2026, 6, 8, 13, 30) / 1000)

const chart = (timestamp: unknown, close: unknown) =>
  ({ chart: { result: [{ timestamp, indicators: { quote: [{ close }] } }] } })

describe('parseYahooChart', () => {
  it('maps timestamps+closes to daily points, dropping null closes', () => {
    const raw = chart([T1, T2, T3], [100.5, null, 102.25])
    expect(parseYahooChart(raw)).toEqual([
      { date: '2026-07-06', close: 100.5 },
      { date: '2026-07-08', close: 102.25 },
    ])
  })
  it('collapses duplicate UTC dates keeping the last close', () => {
    const raw = chart([T1, T1 + 3600], [100, 101])
    expect(parseYahooChart(raw)).toEqual([{ date: '2026-07-06', close: 101 }])
  })
  it('returns [] on malformed / error payloads', () => {
    expect(parseYahooChart(null)).toEqual([])
    expect(parseYahooChart({})).toEqual([])
    expect(parseYahooChart({ chart: { result: null, error: { code: 'Not Found' } } })).toEqual([])
    expect(parseYahooChart(chart('nope', [1]))).toEqual([])
    expect(parseYahooChart(chart([T1], [0]))).toEqual([])          // non-positive close dropped
  })
})
