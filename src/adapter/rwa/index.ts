// src/adapter/rwa/index.ts
import { createHash } from 'node:crypto'
import { PAIR_REGISTRY, filterPairs, type RwaPair } from './pairs.js'
import { compareSeries, type CompareStats, type TokenDailyPoint, type DailyPoint } from './compare.js'
import { fetchTokenDaily } from './coingecko.js'
import { fetchReferenceDaily } from './yahoo.js'
import { str, num } from '../params.js'
import { clampPodName, POD_DESC_MAX } from '../podName.js'
import type { DatanetAdapter, CandidatePod, AdapterContext } from '../types.js'

/** Operator-tunable rwa params (config datanets[id].adapterParams). */
export interface RwaParams { focus?: string; topN?: number; periodDays?: number }

/** Lenient parse (gdelt pattern): wrong-typed fields are dropped so defaults
 *  apply — operator config can never crash discovery. */
export function parseRwaParams(raw: Record<string, unknown> | undefined): RwaParams {
  if (!raw) return {}
  const out: RwaParams = {}
  const focus = str(raw.focus)
  if (focus !== undefined) out.focus = focus
  const topN = num(raw.topN)
  if (topN !== undefined) out.topN = topN
  const periodDays = num(raw.periodDays)
  if (periodDays !== undefined) out.periodDays = periodDays
  return out
}

export interface RwaDeps {
  fetchToken?: (tokenId: string, days: number) => Promise<TokenDailyPoint[]>
  fetchReference?: (ticker: string, rangeDays: number) => Promise<DailyPoint[]>
  now?: () => number
  /** zero-candidate/skip reasons go here (default console.error) — the spec's
   *  "no silent zeros" law: an empty discover() ALWAYS says why. */
  log?: (msg: string) => void
  /** delay between pairs (default 1500ms) — CoinGecko's free tier 429s rapid
   *  successive calls (Task 0). Injectable sleep for tests. */
  sleepMs?: number
  sleepFn?: (ms: number) => Promise<void>
}

const DEFAULT_TOP_N = 2
const DEFAULT_PERIOD_DAYS = 7
const MIN_PERIOD_DAYS = 3
const MAX_PERIOD_DAYS = 30
/** extra fetch margin so weekends/holidays at the window edge don't starve alignment. */
const FETCH_MARGIN_DAYS = 7
const DAY_MS = 86_400_000

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const inWindow = (p: { date: string }, start: string, end: string): boolean => p.date >= start && p.date <= end

function buildDataset(pair: RwaPair, start: string, end: string, stats: CompareStats, token: TokenDailyPoint[], reference: DailyPoint[]) {
  return {
    pair: { token: pair.tokenSymbol, reference: pair.referenceName },
    period: { start, end, tradingDaysCompared: stats.tradingDaysCompared },
    stats: {
      avgTrackingGapPct: stats.avgTrackingGapPct,
      maxDeviationPct: stats.maxDeviationPct,
      maxDeviationDate: stats.maxDeviationDate,
      avgDailyTokenVolumeUsd: stats.avgDailyTokenVolumeUsd,
      closedMarketDriftPct: stats.closedMarketDriftPct,
      tradingDaysCompared: stats.tradingDaysCompared,
    },
    series: { token, reference },
    method: 'daily closes aligned on shared trading days; gap = |token - reference| / reference; closed-market drift = largest token move across a reference-market closure',
    sources: [
      `https://www.coingecko.com/en/coins/${pair.tokenId}`,
      `https://finance.yahoo.com/quote/${encodeURIComponent(pair.referenceTicker)}`,
    ],
  }
}

function headline(stats: CompareStats, start: string, end: string): string {
  const parts = [
    `Avg gap ${stats.avgTrackingGapPct.toFixed(2)}%`,
    `max ${stats.maxDeviationPct.toFixed(2)}% on ${stats.maxDeviationDate}`,
    `${stats.tradingDaysCompared} shared days ${start}..${end}`,
  ]
  if (stats.closedMarketDriftPct !== null) parts.push(`closed-market drift ${stats.closedMarketDriftPct.toFixed(2)}%`)
  if (stats.avgDailyTokenVolumeUsd !== null) parts.push(`avg daily vol $${Math.round(stats.avgDailyTokenVolumeUsd).toLocaleString('en-US')}`)
  return clampPodName(`${parts.join('; ')}. Verifiable series + sources in dataset.`, POD_DESC_MAX)
}

/** Tokenized-RWA tracking adapter (id "rwa") — deterministic pair-registry
 *  comparisons (spec: docs/superpowers/specs/2026-07-15-rwa-adapter-design.md).
 *  No LLM in discovery; the node's CandidateScorer judges downstream. */
export function createRwaAdapter(deps: RwaDeps = {}): DatanetAdapter {
  const fetchToken = deps.fetchToken ?? fetchTokenDaily
  const fetchReference = deps.fetchReference ?? fetchReferenceDaily
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? ((m: string) => console.error(m))
  const sleepMs = deps.sleepMs ?? 1500
  const nap = deps.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  return {
    id: 'rwa',
    async discover(ctx: AdapterContext): Promise<CandidatePod[]> {
      const p = parseRwaParams(ctx.strategy)
      const topN = p.topN ?? ctx.topN ?? DEFAULT_TOP_N
      const periodDays = Math.min(MAX_PERIOD_DAYS, Math.max(MIN_PERIOD_DAYS, p.periodDays ?? DEFAULT_PERIOD_DAYS))
      const periodEnd = utcDate(now())
      const periodStart = utcDate(now() - periodDays * DAY_MS)
      const existing = new Set(ctx.existingPodNames ?? [])
      const skips: string[] = []
      const out: CandidatePod[] = []

      const pairs = filterPairs(PAIR_REGISTRY, p.focus)
      if (pairs.length === 0) {
        log(`orquestra: rwa 0 candidates (datanet ${ctx.datanetId}) — focus "${p.focus ?? ''}" matched no pairs`)
        return []
      }

      let fetchedBefore = false
      for (const pair of pairs) {
        if (out.length >= topN) break
        const podName = clampPodName(`${pair.tokenSymbol} vs ${pair.referenceSymbol} tracking ${periodEnd}`)
        if (existing.has(podName)) { skips.push(`${pair.id}: already published for ${periodEnd}`); continue }
        // Per-pair isolation (spec law 1): one pair's failure skips THAT pair only.
        try {
          // CoinGecko free-tier pacing (Task 0: rapid calls 429) — only between real fetches.
          if (fetchedBefore && sleepMs > 0) await nap(sleepMs)
          fetchedBefore = true
          const [tokenRaw, refRaw] = await Promise.all([
            fetchToken(pair.tokenId, periodDays + FETCH_MARGIN_DAYS),
            fetchReference(pair.referenceTicker, periodDays + FETCH_MARGIN_DAYS),
          ])
          const token = tokenRaw.filter((x) => inWindow(x, periodStart, periodEnd))
          const reference = refRaw.filter((x) => inWindow(x, periodStart, periodEnd))
          const stats = compareSeries(token, reference, pair.class)
          if (stats === null) { skips.push(`${pair.id}: insufficient shared trading days in ${periodStart}..${periodEnd}`); continue }
          const selfScore = Math.max(5, 8 - (stats.tradingDaysCompared < 5 ? 1 : 0) - (stats.avgDailyTokenVolumeUsd === null ? 1 : 0))
          out.push({
            canonicalKey: createHash('sha256').update(`rwa:${ctx.datanetId}:${pair.id}:${periodEnd}`).digest('hex').slice(0, 16),
            podName,
            podDescription: headline(stats, periodStart, periodEnd),
            dataset: buildDataset(pair, periodStart, periodEnd, stats, token, reference),
            selfScore,
            sourceUrl: `https://www.coingecko.com/en/coins/${pair.tokenId}`,
          })
        } catch (e) {
          skips.push(`${pair.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // No silent zeros (spec law 2): empty AND non-empty results surface their skips.
      if (out.length === 0) log(`orquestra: rwa 0 candidates (datanet ${ctx.datanetId}) — ${skips.join('; ') || 'no pairs after topN cap'}`)
      else if (skips.length > 0) log(`orquestra: rwa skipped ${skips.length} pair(s) (datanet ${ctx.datanetId}) — ${skips.join('; ')}`)
      return out
    },
  }
}
