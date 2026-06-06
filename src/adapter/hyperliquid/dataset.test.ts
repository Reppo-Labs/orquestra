// src/adapter/hyperliquid/dataset.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildHlDataset, aggregateRoundTrips, type Fill } from './dataset.js'

const fills = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/hl-fills.json'), 'utf-8'))

const f = (o: Partial<Fill> = {}): Fill => ({
  coin: 'BTC', px: '100', sz: '1', side: 'B', dir: 'Close Long', closedPnl: '0', time: 1, hash: '0x0', ...o,
})

describe('aggregateRoundTrips', () => {
  it('collapses a position scaled out across many partial close fills into ONE trade (the AAVE bug)', () => {
    // 23 Close Short fills, same coin + price, all profitable — this is ONE exit, not 23 trades.
    const aave = Array.from({ length: 23 }, (_, i) =>
      f({ coin: 'AAVE', dir: 'Close Short', side: 'B', sz: '1', px: '82.949', closedPnl: '5', time: 100 + i }))
    const trips = aggregateRoundTrips(aave)
    expect(trips).toHaveLength(1)              // not 23
    expect(trips[0].market).toBe('AAVE')
    expect(trips[0].direction).toBe('short')
    expect(trips[0].pnl).toBeCloseTo(115)      // 23 * 5
    expect(trips[0].win).toBe(true)
    expect(trips[0].n_fills).toBe(23)
  })

  it('reports a losing close-run as ONE losing trade (the MON bug → not "0% over 836")', () => {
    const mon = Array.from({ length: 30 }, (_, i) =>
      f({ coin: 'MON', dir: 'Close Short', side: 'B', sz: '2', px: '1', closedPnl: '-10', time: 200 + i }))
    const trips = aggregateRoundTrips(mon)
    expect(trips).toHaveLength(1)
    expect(trips[0].win).toBe(false)
    expect(trips[0].pnl).toBeCloseTo(-300)
  })

  it('detects a clean round-trip when net size returns to flat (open then close)', () => {
    const trips = aggregateRoundTrips([
      f({ coin: 'BTC', dir: 'Open Long', side: 'B', sz: '1', closedPnl: '0', time: 1 }),
      f({ coin: 'BTC', dir: 'Close Long', side: 'A', sz: '1', closedPnl: '100', time: 2 }),
    ])
    expect(trips).toHaveLength(1)
    expect(trips[0].direction).toBe('long')
    expect(trips[0].pnl).toBeCloseTo(100)
    expect(trips[0].win).toBe(true)
  })

  it('splits two sequential round-trips on the same coin (re-open after close = new trade)', () => {
    const trips = aggregateRoundTrips([
      f({ coin: 'BTC', dir: 'Open Long', side: 'B', sz: '1', closedPnl: '0', time: 1 }),
      f({ coin: 'BTC', dir: 'Close Long', side: 'A', sz: '1', closedPnl: '50', time: 2 }),
      f({ coin: 'BTC', dir: 'Open Long', side: 'B', sz: '1', closedPnl: '0', time: 3 }),
      f({ coin: 'BTC', dir: 'Close Long', side: 'A', sz: '1', closedPnl: '-20', time: 4 }),
    ])
    expect(trips).toHaveLength(2)
    expect(trips[0].pnl).toBeCloseTo(50)
    expect(trips[1].pnl).toBeCloseTo(-20)
  })

  it('tracks concurrent positions on different coins independently', () => {
    const trips = aggregateRoundTrips([
      f({ coin: 'BTC', dir: 'Open Long', side: 'B', sz: '1', closedPnl: '0', time: 1 }),
      f({ coin: 'ETH', dir: 'Open Short', side: 'A', sz: '1', closedPnl: '0', time: 2 }),
      f({ coin: 'BTC', dir: 'Close Long', side: 'A', sz: '1', closedPnl: '10', time: 3 }),
      f({ coin: 'ETH', dir: 'Close Short', side: 'B', sz: '1', closedPnl: '-5', time: 4 }),
    ])
    expect(trips).toHaveLength(2)
    const btc = trips.find((t) => t.market === 'BTC')!
    const eth = trips.find((t) => t.market === 'ETH')!
    expect(btc.win).toBe(true)
    expect(eth.direction).toBe('short')
    expect(eth.win).toBe(false)
  })

  it('does NOT count an open position with no close as a realized trade', () => {
    const trips = aggregateRoundTrips([
      f({ coin: 'BTC', dir: 'Open Long', side: 'B', sz: '1', closedPnl: '0', time: 1 }),
    ])
    expect(trips).toHaveLength(0)
  })

  it('captures size-weighted entry/exit prices for a round-trip (the detail the rubric wants)', () => {
    const trips = aggregateRoundTrips([
      f({ coin: 'BTC', dir: 'Open Long', side: 'B', sz: '2', px: '100', closedPnl: '0', time: 1 }),
      f({ coin: 'BTC', dir: 'Close Long', side: 'A', sz: '2', px: '110', closedPnl: '20', time: 2 }),
    ])
    expect(trips[0].entry_px).toBeCloseTo(100)
    expect(trips[0].exit_px).toBeCloseTo(110)
  })

  it('reports entry_px=null for a truncated close-only run (open predates the window) but still gives exit_px', () => {
    const trips = aggregateRoundTrips([
      f({ coin: 'AAVE', dir: 'Close Short', side: 'B', sz: '1', px: '82.9', closedPnl: '5', time: 1 }),
      f({ coin: 'AAVE', dir: 'Close Short', side: 'B', sz: '1', px: '83.1', closedPnl: '5', time: 2 }),
    ])
    expect(trips[0].entry_px).toBeNull()       // honest: we never saw the open
    expect(trips[0].exit_px).toBeCloseTo(83.0) // size-weighted avg of the closes
  })

  it('deduplicates tx hashes (one on-chain tx can produce many fills)', () => {
    const trips = aggregateRoundTrips([
      f({ coin: 'BTC', dir: 'Close Long', side: 'A', sz: '1', px: '100', closedPnl: '5', time: 1, hash: '0xsame' }),
      f({ coin: 'BTC', dir: 'Close Long', side: 'A', sz: '1', px: '100', closedPnl: '5', time: 2, hash: '0xsame' }),
    ])
    expect(trips[0].tx_hashes).toEqual(['0xsame'])
  })
})

describe('buildHlDataset (round-trip metrics)', () => {
  it('builds a candidate whose metrics are per round-trip, not per fill', () => {
    const c = buildHlDataset('0xWALLET', fills, '9')
    expect(c).not.toBeNull()
    const ds = c!.dataset as { aggregate_metrics: { n_trades: number; win_rate: number; sum_pnl: number }; trades: unknown[] }
    // 21 close fills, no opens, keyed by (coin,direction): (BTC,long),(ETH,short),
    // (ETH,long),(SOL,short) → 4 truncated round-trips, NOT 21 per-fill "trades".
    expect(ds.aggregate_metrics.n_trades).toBe(4)
    expect(ds.trades).toHaveLength(4)
    expect(ds.aggregate_metrics.win_rate).toBeGreaterThanOrEqual(0)
    expect(ds.aggregate_metrics.win_rate).toBeLessThanOrEqual(100)
    // sum_pnl is preserved across aggregation (= sum of every close fill's pnl)
    expect(ds.aggregate_metrics.sum_pnl).toBe(741)
    expect(c!.canonicalKey).toMatch(/^[0-9a-f]{16}$/)
    expect(c!.podName).toContain('HL perps')
  })

  it('returns null below the 20-closed-fill substance floor', () => {
    expect(buildHlDataset('0xWALLET', fills.slice(0, 5), '9')).toBeNull()
  })

  it('returns null for an empty / all-unclosed fill set', () => {
    expect(buildHlDataset('0xWALLET', [], '9')).toBeNull()
    expect(buildHlDataset('0xWALLET', [{ coin: 'BTC', px: '1', sz: '1', side: 'B', dir: 'Open Long', closedPnl: '0', time: 1, hash: '0x0' }], '9')).toBeNull()
  })

  it('excludes malformed fills and keeps sum_pnl finite', () => {
    const malformed = { coin: 'BTC', px: 'x', sz: '1', side: 'B' as const, dir: 'Close Long', closedPnl: 'oops', time: 1, hash: '0x0' }
    const c = buildHlDataset('0xWALLET', [...fills, malformed], '9')
    expect(c).not.toBeNull()
    const ds = c!.dataset as { aggregate_metrics: { sum_pnl: number } }
    expect(Number.isFinite(ds.aggregate_metrics.sum_pnl)).toBe(true)
  })
})
