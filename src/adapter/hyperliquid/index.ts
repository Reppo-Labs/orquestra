// src/adapter/hyperliquid/index.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rankByMargin } from './rank.js'
import { buildHlDataset, aggregateRoundTrips } from './dataset.js'
import { fillsWindow, type FillsWindow } from './window.js'
import { walletQuality, passesQualityGate, type QualityParams } from './quality.js'
import { queryEpochJson } from '../../reppo/queryEpoch.js'
import type { DatanetAdapter, CandidatePod, AdapterContext } from '../types.js'

const execFileAsync = promisify(execFile)

/** Leaderboard ranking window (HL's own metric) — used only to pre-filter a
 *  candidate pool; selection is by realized in-window PnL (see discover). */
const LEADERBOARD_WINDOW = 'week'

export interface HlParams extends QualityParams {
  /** how many ranked leaderboard wallets to consider as the candidate pool. */
  poolSize: number
  /** leaderboard volume floor (liquidity pre-filter). */
  minVlm: number
  /** days before the epoch start to reach back so opens are captured. */
  openLookbackDays: number
}

export const HL_DEFAULTS: HlParams = {
  poolSize: 20,
  minVlm: 100_000,
  openLookbackDays: 45,
  minRoundTrips: 3,
  minMarkets: 2,
  minRealizedPnl: 0,
}

export interface HlFetchers {
  fetchLeaderboard(): Promise<unknown>
  /** fetch a wallet's fills bounded to [window.startTime, window.endTime] (ms). */
  fetchFills(wallet: string, window: FillsWindow): Promise<unknown>
}

export interface HlDeps {
  fetchers?: HlFetchers
  params?: Partial<HlParams>
  /** current on-chain epoch (default: reppo CLI). Injected in tests. */
  epochProvider?: () => Promise<{ epochStart: number; epochDurationSeconds: number }>
  /** clock (default: Date.now). Injected in tests. */
  now?: () => number
}

/** Default fetchers hit the HL public API (no auth) via curl. fetchFills pages
 *  forward over the window (HL caps ~2000 fills/response) until exhausted. */
const defaultFetchers: HlFetchers = {
  async fetchLeaderboard() {
    const { stdout } = await execFileAsync('curl', ['-fsS', '--max-time', '60', 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'], { maxBuffer: 64 * 1024 * 1024 })
    return JSON.parse(stdout)
  },
  async fetchFills(wallet: string, window: FillsWindow) {
    const all: unknown[] = []
    let cursor = window.startTime
    for (let page = 0; page < 50; page++) {
      const body = JSON.stringify({ type: 'userFillsByTime', user: wallet, startTime: cursor, endTime: window.endTime, aggregateByTime: false })
      const { stdout } = await execFileAsync('curl', ['-fsS', '--max-time', '60', '-H', 'Content-Type: application/json', '-d', body, 'https://api.hyperliquid.xyz/info'], { maxBuffer: 64 * 1024 * 1024 })
      const batch = JSON.parse(stdout) as Array<{ time: number }>
      if (!Array.isArray(batch) || batch.length === 0) break
      all.push(...batch)
      const lastT = batch[batch.length - 1]!.time
      if (batch.length < 2000 || lastT <= cursor) break
      cursor = lastT + 1
    }
    return all
  },
}

/** Reference adapter: HL leaderboard → margin-ranked wallets → labeled datasets.
 *  Routes to the TradingGym datanet (id 9 / name contains "tradinggym"). */
export function createHyperliquidAdapter(fetchers: HlFetchers = defaultFetchers): DatanetAdapter {
  return {
    id: 'hyperliquid',
    matches(datanetId: string, rubric: DatanetRubric): boolean {
      return datanetId === '9' || /tradinggym/i.test(rubric.name ?? '')
    },
    async discover(ctx: AdapterContext): Promise<CandidatePod[]> {
      const lb = await fetchers.fetchLeaderboard()
      const wallets = rankByMargin(lb, WINDOW, ctx.topN, MIN_VLM)
      const out: CandidatePod[] = []
      for (const w of wallets) {
        try {
          const fills = await fetchers.fetchFills(w)
          const cand = buildHlDataset(w, fills, ctx.datanetId)
          if (cand) out.push(cand)
        } catch (err) {
          console.warn(`[hl-adapter] fetchFills failed for ${w}:`, err)
        }
      }
      return out
    },
  }
}
