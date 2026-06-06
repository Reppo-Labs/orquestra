// src/adapter/hyperliquid/index.test.ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHyperliquidAdapter } from './index.js'
import type { FillsWindow } from './window.js'
import type { DatanetRubric } from '../../rubric/types.js'

const lb = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/hl-leaderboard.json'), 'utf-8'))
const fills = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/hl-fills.json'), 'utf-8'))
const rubric = { datanetId: '9', name: 'TradingGym AI', canMint: true } as DatanetRubric

// Deterministic epoch + clock so the window is fixed in tests (no network, no Date.now).
const epochProvider = async () => ({ epochStart: 1_700_000_000, epochDurationSeconds: 172_800 })
const now = () => 1_700_100_000_000

// Helper: a wallet with 2 markets, each a complete round-trip (open + 10 partial closes
// that net the position back to flat → entry_px present), so it clears the 20-closed-fill
// floor in buildHlDataset AND the round-trip quality gate.
const wallet = (pnlPerClose: { btc: number; eth: number }) => {
  const out: unknown[] = []
  out.push({ coin: 'BTC', dir: 'Open Long', side: 'B', sz: '10', px: '100', closedPnl: '0', time: 1, hash: '0xo1' })
  for (let i = 0; i < 10; i++) out.push({ coin: 'BTC', dir: 'Close Long', side: 'A', sz: '1', px: '200', closedPnl: String(pnlPerClose.btc), time: 2 + i, hash: `0xb${i}` })
  out.push({ coin: 'ETH', dir: 'Open Long', side: 'B', sz: '10', px: '10', closedPnl: '0', time: 20, hash: '0xo2' })
  for (let i = 0; i < 10; i++) out.push({ coin: 'ETH', dir: 'Close Long', side: 'A', sz: '1', px: '11', closedPnl: String(pnlPerClose.eth), time: 21 + i, hash: `0xe${i}` })
  return out
}

describe('hyperliquidAdapter', () => {
  it('has id "hyperliquid"', () => {
    expect(createHyperliquidAdapter({ fetchers: { fetchLeaderboard: async () => lb, fetchFills: async () => fills } }).id).toBe('hyperliquid')
  })

  it('passes the computed epoch-aligned window to fetchFills (not now-7d)', async () => {
    const fetchFills = vi.fn(async (_w: string, _win: FillsWindow) => fills)
    const a = createHyperliquidAdapter({
      fetchers: { fetchLeaderboard: async () => lb, fetchFills },
      epochProvider, now, params: { minRealizedPnl: -1e12, minRoundTrips: 1, minMarkets: 1 },
    })
    await a.discover({ datanetId: '9', rubric, topN: 2 })
    expect(fetchFills).toHaveBeenCalled()
    const win = fetchFills.mock.calls[0][1]
    expect(win.startTime).toBe((1_700_000_000 - 45 * 86_400) * 1000) // default openLookbackDays
    expect(win.endTime).toBe(1_700_100_000_000)
  })

  it('gates out low-quality wallets (default gate rejects the thin close-only fixture)', async () => {
    // hl-fills.json is close-only (entry_px null) → 0 complete round-trips → rejected.
    const a = createHyperliquidAdapter({
      fetchers: { fetchLeaderboard: async () => lb, fetchFills: async () => fills },
      epochProvider, now,
    })
    const cands = await a.discover({ datanetId: '9', rubric, topN: 5 })
    expect(cands).toEqual([])
  })

  it('emits candidates and ranks them by realized PnL when wallets are high quality', async () => {
    const winner = wallet({ btc: 90, eth: 10 }) // realized +1000
    const loser = wallet({ btc: 1, eth: 0.5 })  // realized +15
    const byWallet: Record<string, unknown> = { '0xAAA': winner, '0xBBB': loser }
    const a = createHyperliquidAdapter({
      fetchers: { fetchLeaderboard: async () => lb, fetchFills: async (w) => byWallet[w] ?? [] },
      epochProvider, now,
      params: { minRoundTrips: 2, minMarkets: 2, minRealizedPnl: 0, minVlm: 100_000, poolSize: 12 },
    })
    const cands = await a.discover({ datanetId: '9', rubric, topN: 5 })
    expect(cands.length).toBe(2)
    expect(cands[0].podName).toContain('0xAAA') // winner (higher realized PnL) ranked first
  })

  it('isolates a wallet whose fetchFills throws (others still considered, no throw)', async () => {
    let n = 0
    const a = createHyperliquidAdapter({
      fetchers: {
        fetchLeaderboard: async () => lb,
        fetchFills: async () => { if (++n === 1) throw new Error('rpc'); return fills },
      },
      epochProvider, now, params: { minRoundTrips: 1, minMarkets: 1, minRealizedPnl: -1e12 },
    })
    const cands = await a.discover({ datanetId: '9', rubric, topN: 5 })
    expect(Array.isArray(cands)).toBe(true)
  })
})
