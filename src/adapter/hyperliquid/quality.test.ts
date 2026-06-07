// src/adapter/hyperliquid/quality.test.ts
import { describe, it, expect } from 'vitest'
import { walletQuality, passesQualityGate, type QualityParams } from './quality.js'
import type { RoundTrip } from './dataset.js'

const trip = (o: Partial<RoundTrip> = {}): RoundTrip => ({
  market: 'BTC', direction: 'long', pnl: 100, win: true, n_fills: 2,
  size: 1, entry_px: 100, exit_px: 110, first_ms: 1, last_ms: 2, tx_hashes: ['0x1'], ...o,
})
const params: QualityParams = { minRoundTrips: 3, minMarkets: 2, minRealizedPnl: 0 }

describe('walletQuality', () => {
  it('summarizes realized PnL, complete trips, markets, win rate', () => {
    const q = walletQuality([
      trip({ market: 'BTC', pnl: 100 }),
      trip({ market: 'ETH', pnl: -40 }),
      trip({ market: 'SOL', pnl: 60, entry_px: null }), // incomplete (no captured open)
    ])
    expect(q.realizedPnl).toBeCloseTo(120)
    expect(q.nTrips).toBe(3)
    expect(q.nCompleteTrips).toBe(2)   // SOL had entry_px null
    expect(q.nMarkets).toBe(3)
    expect(q.winRate).toBeCloseTo(66.67)
  })
})

describe('passesQualityGate', () => {
  it('passes a wallet with enough complete trips, markets, and positive PnL', () => {
    const trips = [
      trip({ market: 'BTC' }), trip({ market: 'ETH' }), trip({ market: 'SOL' }),
    ]
    expect(passesQualityGate(walletQuality(trips), params)).toBe(true)
  })

  it('rejects when too few COMPLETE round-trips (entry_px present)', () => {
    const trips = [trip({ entry_px: null }), trip({ entry_px: null }), trip({ entry_px: null })]
    expect(passesQualityGate(walletQuality(trips), params)).toBe(false)
  })

  it('rejects a single-market wallet (one lucky position)', () => {
    const trips = [trip({ market: 'BTC' }), trip({ market: 'BTC' }), trip({ market: 'BTC' })]
    expect(passesQualityGate(walletQuality(trips), params)).toBe(false)
  })

  it('rejects net-negative realized PnL', () => {
    const trips = [trip({ market: 'BTC', pnl: -100 }), trip({ market: 'ETH', pnl: 10 }), trip({ market: 'SOL', pnl: 10 })]
    expect(passesQualityGate(walletQuality(trips), params)).toBe(false)
  })
})
