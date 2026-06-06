// src/adapter/hyperliquid/dataset.ts
import { createHash } from 'node:crypto'
import type { CandidatePod } from '../types.js'

export interface Fill { coin: string; px: string; sz: string; side: 'B' | 'A'; dir?: string; closedPnl: string; time: number; hash: string }

const MIN_CLOSED = 20

/** Return n as a finite number, or 0 if n is non-finite (NaN/±Infinity). */
const fin = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** A reconstructed round-trip position: the realized outcome of opening and
 *  (partially or fully) closing one direction on one market. */
export interface RoundTrip {
  market: string
  direction: 'long' | 'short'
  pnl: number
  win: boolean
  /** number of underlying fills that composed this position. */
  n_fills: number
  /** total closed size across the position's close fills. */
  size: number
  /** size-weighted avg open price; null when the open predates the window (close-only run). */
  entry_px: number | null
  /** size-weighted avg close price. */
  exit_px: number | null
  first_ms: number
  last_ms: number
  /** deduped sample of tx hashes for verification (one tx can yield many fills). */
  tx_hashes: string[]
}

interface Acc {
  market: string
  direction: 'long' | 'short'
  pnl: number
  nFills: number
  openSize: number
  closeSize: number
  /** Σ openSize*px and Σ closeSize*px — for size-weighted entry/exit prices. */
  openNotional: number
  closeNotional: number
  closed: boolean
  first: number
  last: number
  hashes: string[]
}

const EPS = 1e-9

/** Aggregate raw HL fills into round-trip positions.
 *
 *  Why this is needed: HL returns one fill per partial execution, so a single
 *  position scaled out across N fills looks like N "trades" with identical
 *  outcomes — which makes win-rate degenerate (e.g. 23 partial closes of one
 *  winning AAVE short read as "100% over 23 trades"). Metrics must be computed
 *  per position, not per fill.
 *
 *  Positions are keyed by (coin, direction): "Close Short" and "Close Long" on
 *  the same coin close DIFFERENT positions and must never net against each other.
 *  A round-trip is flushed when its closed size meets its opened size (a clean
 *  open→close), or when the position re-opens after a close (a new round-trip),
 *  or at end-of-window. The 7-day window often truncates the open side (we see
 *  closes whose opens predate the window); such close-only runs are emitted as a
 *  single realized position (their summed closedPnl), which is the honest unit. */
export function aggregateRoundTrips(rawFills: Fill[]): RoundTrip[] {
  const fills = rawFills
    .filter((f) => f && typeof f.coin === 'string' && typeof f.dir === 'string')
    .slice()
    .sort((a, b) => fin(a.time) - fin(b.time))

  const open = new Map<string, Acc>()
  const out: RoundTrip[] = []

  const flush = (key: string): void => {
    const s = open.get(key)
    open.delete(key)
    if (!s || !s.closed) return // only realized (closed) positions count
    const px = (notional: number, size: number): number | null =>
      size > EPS ? Math.round((notional / size) * 1e6) / 1e6 : null
    out.push({
      market: s.market.replace('xyz:', ''),
      direction: s.direction,
      pnl: Math.round(s.pnl * 100) / 100,
      win: s.pnl > 0,
      n_fills: s.nFills,
      size: Math.round(s.closeSize * 1e6) / 1e6,
      entry_px: px(s.openNotional, s.openSize),   // null when the open predates the window
      exit_px: px(s.closeNotional, s.closeSize),
      first_ms: s.first,
      last_ms: s.last,
      tx_hashes: [...new Set(s.hashes)],            // one tx can yield many fills
    })
  }

  for (const f of fills) {
    const dir = f.dir ?? ''
    const isClose = dir.includes('Close')
    const isOpen = dir.includes('Open')
    const direction: 'long' | 'short' = dir.includes('Short') ? 'short' : 'long'
    const key = `${f.coin}|${direction}`

    let s = open.get(key)
    // Re-opening a position that already had closes → boundary: emit the prior round-trip.
    if (isOpen && s && s.closed) { flush(key); s = undefined }
    if (!s) {
      s = { market: f.coin, direction, pnl: 0, nFills: 0, openSize: 0, closeSize: 0, openNotional: 0, closeNotional: 0, closed: false, first: fin(f.time), last: fin(f.time), hashes: [] }
      open.set(key, s)
    }

    const sz = Math.abs(fin(f.sz))
    const px = fin(f.px)
    if (isOpen) { s.openSize += sz; s.openNotional += sz * px }
    if (isClose) { s.closeSize += sz; s.closeNotional += sz * px; s.closed = true }
    s.pnl += fin(f.closedPnl)
    s.nFills += 1
    s.last = fin(f.time)
    if (s.hashes.length < 50 && typeof f.hash === 'string') s.hashes.push(f.hash)

    // Clean round-trip: we opened in-window and have now closed at least as much.
    if (s.closed && s.openSize > 0 && s.closeSize + EPS >= s.openSize) flush(key)
  }

  for (const key of [...open.keys()]) flush(key)
  // Deterministic order: by first fill time, then market.
  return out.sort((a, b) => a.first_ms - b.first_ms || a.market.localeCompare(b.market))
}

/** Build a labeled HL-perp trade dataset candidate from a wallet's fills.
 *  Returns null below the 20-closed-fill substance floor (too thin to evaluate)
 *  or when no realized round-trip can be reconstructed. */
export function buildHlDataset(wallet: string, rawFills: unknown, datanetId: string): CandidatePod | null {
  const fills = rawFills as Fill[]
  if (!Array.isArray(fills) || fills.length === 0) return null
  const closed = fills.filter((f) => (f.dir ?? '').includes('Close') && Number.isFinite(Number(f.closedPnl)))
  if (closed.length < MIN_CLOSED) return null

  const trips = aggregateRoundTrips(fills)
  if (trips.length === 0) return null

  const wins = trips.filter((t) => t.pnl > 0).length
  const winRate = Math.round((wins / trips.length) * 10000) / 100
  const sumPnl = trips.reduce((a, t) => a + t.pnl, 0)
  let peak = 0, cum = 0, maxDd = 0
  for (const t of trips) { cum += t.pnl; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum) }

  // canonicalKey stays keyed on the closed-fill window (wallet + span + count) for
  // stability; epoch-aligned keys are a separate (dedup) change.
  const firstT = closed[0]!.time, lastT = closed[closed.length - 1]!.time
  const canonical = `trades:${datanetId}:${wallet}:${firstT}:${lastT}:${closed.length}`
  const canonicalKey = createHash('sha256').update(canonical).digest('hex').slice(0, 16)

  const dataset = {
    kind: 'hl-perp-trades', schema_version: 2,
    source: { wallet, venue: 'hyperliquid-mainnet' },
    aggregate_metrics: {
      n_trades: trips.length, win_rate: winRate,
      sum_pnl: Math.round(sumPnl), max_drawdown_usd: Math.round(maxDd),
      n_fills: closed.length,
    },
    trades: trips,
  }
  const short = `${wallet.slice(0, 6)}..${wallet.slice(-4)}`
  return {
    canonicalKey,
    podName: `HL perps, ${short}: ${trips.length} trades`,
    podDescription: `Hyperliquid perp dataset from ${short} — ${trips.length} round-trip trades (${closed.length} fills), win_rate ${winRate}%, sum_pnl ${Math.round(sumPnl)}.`,
    dataset,
  }
}
