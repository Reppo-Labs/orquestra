// src/adapter/hyperliquid/index.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rankByMargin } from './rank.js'
import { buildHlDataset } from './dataset.js'
import type { DatanetAdapter, CandidatePod, AdapterContext } from '../types.js'
import type { DatanetRubric } from '../../rubric/types.js'

const execFileAsync = promisify(execFile)

export interface HlFetchers {
  fetchLeaderboard(): Promise<unknown>
  fetchFills(wallet: string): Promise<unknown>
}

const WINDOW = 'week'
const MIN_VLM = 100000

/** Default fetchers hit the HL public API (no auth). curl via subprocess keeps
 *  it dependency-free; confirm endpoints at integration. */
const defaultFetchers: HlFetchers = {
  async fetchLeaderboard() {
    const { stdout } = await execFileAsync('curl', ['-fsS', '--max-time', '60', 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'], { maxBuffer: 64 * 1024 * 1024 })
    return JSON.parse(stdout)
  },
  async fetchFills(wallet: string) {
    const now = Date.now()
    const body = JSON.stringify({ type: 'userFillsByTime', user: wallet, startTime: now - 7 * 86400_000, aggregateByTime: false })
    const { stdout } = await execFileAsync('curl', ['-fsS', '--max-time', '60', '-H', 'Content-Type: application/json', '-d', body, 'https://api.hyperliquid.xyz/info'], { maxBuffer: 64 * 1024 * 1024 })
    return JSON.parse(stdout)
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
