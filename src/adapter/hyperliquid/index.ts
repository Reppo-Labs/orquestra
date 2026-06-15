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

const HL_PAGE_SIZE = 2000
const MAX_PAGES = 50

const finite = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** Page through fills over [window.startTime, window.endTime] (ms) using an injected
 *  page fetcher. Dedups by `hash` so fills sharing a boundary timestamp are neither
 *  dropped nor double-counted; terminates on a short page or when a page adds nothing
 *  new (the only case left is >HL_PAGE_SIZE fills at one identical ms — an HL limit we
 *  cannot page past; documented). */
export async function fetchFillsPaged(
  fetchPage: (startTime: number, endTime: number) => Promise<Array<{ time?: number; hash?: string }>>,
  window: FillsWindow,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<unknown[]> {
  const pageSize = opts.pageSize ?? HL_PAGE_SIZE
  const maxPages = opts.maxPages ?? MAX_PAGES
  const seen = new Set<string>()
  const all: unknown[] = []
  let cursor = window.startTime
  for (let page = 0; page < maxPages; page++) {
    const batch = await fetchPage(cursor, window.endTime)
    if (!Array.isArray(batch) || batch.length === 0) break
    let added = 0
    for (const f of batch) {
      const key = typeof f.hash === 'string' ? f.hash : JSON.stringify(f)
      if (!seen.has(key)) { seen.add(key); all.push(f); added++ }
    }
    if (batch.length < pageSize) break
    // Boundary = MAX time in the batch, not the last element: HL returns ascending
    // today (max == last), but taking the max keeps paging correct even if a page is
    // returned descending or unordered (otherwise the cursor could stall and silently
    // truncate every fill past the first page).
    const lastT = Math.max(...batch.map((f) => finite(f.time)))
    // Re-request from lastT (inclusive) so same-ms fills beyond the page boundary are
    // captured; dedup above removes the overlap. If a full page made no progress, stop.
    if (lastT <= cursor && added === 0) break
    cursor = lastT
  }
  return all
}

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
    return fetchFillsPaged(async (startTime, endTime) => {
      const body = JSON.stringify({ type: 'userFillsByTime', user: wallet, startTime, endTime, aggregateByTime: false })
      const { stdout } = await execFileAsync('curl', ['-fsS', '--max-time', '60', '-H', 'Content-Type: application/json', '-d', body, 'https://api.hyperliquid.xyz/info'], { maxBuffer: 64 * 1024 * 1024 })
      const parsed = JSON.parse(stdout)
      return Array.isArray(parsed) ? parsed : []
    }, window)
  },
}

/** Reference adapter: HL leaderboard (candidate pool) → epoch-aligned fills per
 *  wallet → reconstructed round-trips → rank by realized in-window PnL → quality
 *  gate → labeled datasets. */
export function createHyperliquidAdapter(deps: HlDeps = {}): DatanetAdapter {
  const fetchers = deps.fetchers ?? defaultFetchers
  const params: HlParams = { ...HL_DEFAULTS, ...deps.params }
  const epochProvider = deps.epochProvider ?? (async () => {
    const e = await queryEpochJson()
    return { epochStart: e.epochStart, epochDurationSeconds: e.epochDurationSeconds }
  })
  const now = deps.now ?? (() => Date.now())

  return {
    id: 'hyperliquid',
    matches(datanetId: string): boolean {
      return datanetId === '9' || datanetId === 'hyperliquid'
    },
    async discover(ctx: AdapterContext): Promise<CandidatePod[]> {
      // A failed epoch/leaderboard fetch throws out of discover by design: runCycle wraps
      // each datanet's mint in per-datanet try/catch, so this datanet is skipped and logged
      // while votes + other datanets proceed. (Per-wallet failures below are isolated locally.)
      const epoch = await epochProvider()
      const window = fillsWindow(epoch, params.openLookbackDays, now())

      const lb = await fetchers.fetchLeaderboard()
      const pool = rankByMargin(lb, LEADERBOARD_WINDOW, params.poolSize, params.minVlm)

      const scored: Array<{ cand: CandidatePod; realizedPnl: number; nTrips: number }> = []
      for (const wallet of pool) {
        try {
          const fills = await fetchers.fetchFills(wallet, window)
          const trips = aggregateRoundTrips(fills as Parameters<typeof aggregateRoundTrips>[0])
          const q = walletQuality(trips)
          if (!passesQualityGate(q, params)) continue
          const cand = buildHlDataset(wallet, fills, ctx.datanetId)
          if (cand) scored.push({ cand, realizedPnl: q.realizedPnl, nTrips: q.nCompleteTrips })
        } catch (err) {
          console.warn(`[hl-adapter] wallet ${wallet} skipped:`, err instanceof Error ? err.message : String(err))
        }
      }

      // Select by realized in-window PnL (NOT the leaderboard metric) — fixes the
      // rank/label contradiction where a top-ranked wallet showed in-window losses.
      // Tiebreak by nTrips for deterministic ranking when PnL is equal.
      scored.sort((a, b) => b.realizedPnl - a.realizedPnl || b.nTrips - a.nTrips)
      return scored.slice(0, ctx.topN).map((s) => s.cand)
    },
  }
}
