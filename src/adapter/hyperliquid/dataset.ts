// src/adapter/hyperliquid/dataset.ts
import { createHash } from 'node:crypto'
import type { CandidatePod } from '../types.js'

interface Fill { coin: string; px: string; sz: string; side: 'B' | 'A'; dir?: string; closedPnl: string; time: number; hash: string }

const MIN_CLOSED = 20

/** Build a labeled HL-perp trade dataset candidate from a wallet's fills.
 *  Returns null below the 20-closed-trade floor (too thin to evaluate). */
export function buildHlDataset(wallet: string, rawFills: unknown, datanetId: string): CandidatePod | null {
  const fills = rawFills as Fill[]
  if (!Array.isArray(fills) || fills.length === 0) return null
  const closed = fills.filter((f) => Number(f.closedPnl) !== 0)
  if (closed.length < MIN_CLOSED) return null

  const wins = closed.filter((f) => Number(f.closedPnl) > 0).length
  const sumPnl = closed.reduce((a, f) => a + Number(f.closedPnl), 0)
  let peak = 0, cum = 0, maxDd = 0
  for (const f of closed) { cum += Number(f.closedPnl); peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum) }
  const firstT = closed[0]!.time, lastT = closed[closed.length - 1]!.time
  const trades = closed.map((f) => ({
    market: f.coin.replace('xyz:', ''),
    direction: (f.dir ?? '').includes('Short') ? 'short' : 'long',
    size: Number(f.sz), fill_price: Number(f.px),
    outcome: { pnl: Math.round(Number(f.closedPnl) * 100) / 100, win: Number(f.closedPnl) > 0 },
    verification: { timestamp_ms: f.time, tx_hash: f.hash },
  }))
  const winRate = Math.round((wins / closed.length) * 10000) / 100

  const canonical = `trades:${datanetId}:${wallet}:${firstT}:${lastT}:${closed.length}`
  const canonicalKey = createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  const dataset = {
    kind: 'hl-perp-trades', schema_version: 1,
    source: { wallet, venue: 'hyperliquid-mainnet' },
    aggregate_metrics: {
      n_trades: closed.length, win_rate: winRate,
      sum_pnl: Math.round(sumPnl), max_drawdown_usd: Math.round(maxDd),
    },
    trades,
  }
  const short = `${wallet.slice(0, 6)}..${wallet.slice(-4)}`
  return {
    canonicalKey,
    podName: `HL perps, ${short}: ${closed.length} trades`,
    podDescription: `Hyperliquid perp dataset from ${short} — ${closed.length} closed trades, win_rate ${winRate}%, sum_pnl ${Math.round(sumPnl)}.`,
    dataset,
  }
}
