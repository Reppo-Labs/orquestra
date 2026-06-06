// src/adapter/hyperliquid/quality.ts
import type { RoundTrip } from './dataset.js'

export interface WalletQuality {
  realizedPnl: number
  nTrips: number
  /** round-trips whose open was captured in-window (entry_px present). */
  nCompleteTrips: number
  nMarkets: number
  winRate: number
}

export interface QualityParams {
  /** minimum COMPLETE round-trips (entry_px present) — rubric wants entry+sizing+exit. */
  minRoundTrips: number
  /** minimum distinct markets — guard against one lucky position. */
  minMarkets: number
  /** minimum realized PnL over the window. */
  minRealizedPnl: number
}

/** Summarize a wallet's reconstructed round-trips. Pure. */
export function walletQuality(trips: RoundTrip[]): WalletQuality {
  const realizedPnl = trips.reduce((a, t) => a + t.pnl, 0)
  const nCompleteTrips = trips.filter((t) => t.entry_px != null).length
  const nMarkets = new Set(trips.map((t) => t.market)).size
  const wins = trips.filter((t) => t.pnl > 0).length
  return {
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    nTrips: trips.length,
    nCompleteTrips,
    nMarkets,
    winRate: trips.length ? Math.round((wins / trips.length) * 10000) / 100 : 0,
  }
}

/** Rubric-aligned selection gate. Pure. */
export function passesQualityGate(q: WalletQuality, p: QualityParams): boolean {
  return q.nCompleteTrips >= p.minRoundTrips && q.nMarkets >= p.minMarkets && q.realizedPnl >= p.minRealizedPnl
}
