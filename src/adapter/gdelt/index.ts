// src/adapter/gdelt/index.ts
import type { LanguageModel } from 'ai'
import { fetchGeoEvents, buildGdeltQuery, type GeoArticle, type GdeltQuery } from './gdelt.js'
import { synthesizeClaims, type GdeltStrategy } from './claim.js'
import { filterNovel } from './dedup.js'
import type { DatanetAdapter, CandidatePod, AdapterContext } from '../types.js'

export interface GdeltDeps {
  model?: LanguageModel
  fetchEvents?: (q: GdeltQuery) => Promise<GeoArticle[]>
  generate?: (args: { system: string; prompt: string }) => Promise<{ claims: unknown[] }>
  defaults?: Partial<GdeltStrategy> & { timespanHours?: number; maxRecords?: number; query?: string }
  /** Don't hit GDELT more than once per this interval, regardless of cycle cadence.
   *  GDELT throttles per-IP; at sub-hour cadences a per-cycle fetch trips its limit.
   *  Default 30 min. The adapter instance persists across cycles, so the last-fetch
   *  time lives in its closure. */
  minFetchIntervalMs?: number
  /** injectable clock for tests. */
  now?: () => number
}

const STRATEGY_DEFAULTS: GdeltStrategy = { focus: 'global geopolitical flashpoints', angle: 'balanced', brief: '', topN: 8, minImportance: 7 }
const DEFAULT_MIN_FETCH_INTERVAL_MS = 30 * 60_000

/** GDELT source adapter (id "gdelt") — reusable across news/claims datanets; personalized
 *  per (datanet, operator) via ctx.strategy. */
export function createGdeltAdapter(deps: GdeltDeps = {}): DatanetAdapter {
  const fetchEvents = deps.fetchEvents ?? fetchGeoEvents
  const minInterval = deps.minFetchIntervalMs ?? DEFAULT_MIN_FETCH_INTERVAL_MS
  const now = deps.now ?? (() => Date.now())
  // last fetch time per query string (different datanets/foci throttle independently).
  const lastFetchAt = new Map<string, number>()
  return {
    id: 'gdelt',
    matches(_datanetId: string, _rubric: unknown): boolean {
      return true
    },
    async discover(ctx: AdapterContext): Promise<CandidatePod[]> {
      const s = ctx.strategy as Partial<GdeltStrategy> | undefined
      const strategy: GdeltStrategy = {
        ...STRATEGY_DEFAULTS, ...deps.defaults, ...s,
        // operator's adapterParams topN wins, else the cycle's topN, else the default.
        topN: s?.topN ?? deps.defaults?.topN ?? ctx.topN ?? STRATEGY_DEFAULTS.topN,
      }
      const q: GdeltQuery = {
        query: deps.defaults?.query ?? buildGdeltQuery(strategy.focus),
        timespanHours: deps.defaults?.timespanHours ?? 24,
        maxRecords: deps.defaults?.maxRecords ?? 75,
      }
      // Throttle guard: skip the fetch if a SUCCESSFUL fetch of this same query
      // happened within minInterval. GDELT rate-limits per IP; at a low cadence one
      // fetch per cycle is fine, at high cadence this prevents a 429 storm.
      const last = lastFetchAt.get(q.query)
      const t = now()
      if (last !== undefined && t - last < minInterval) {
        console.error(`orquestra: gdelt fetch skipped for "${q.query}" — throttled (last success ${Math.round((t - last) / 1000)}s ago, min ${Math.round(minInterval / 1000)}s)`)
        return []
      }
      // A fetch failure (GDELT 429 rate limit, network blip) means no candidates THIS
      // cycle — it must not throw into runCycle and mark the whole datanet errored.
      // The timestamp is recorded only on SUCCESS, so a transient failure retries next
      // cycle (fetchGeoEvents' own 15s/60s/180s ladder handles within-attempt 429s).
      let articles: GeoArticle[]
      try {
        articles = await fetchEvents(q)
      } catch (e) {
        console.error(`orquestra: gdelt fetch failed (skipping mint discovery this cycle) — ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
        return []
      }
      lastFetchAt.set(q.query, t) // only successful fetches count toward the throttle
      if (articles.length === 0) return []
      const cands = await synthesizeClaims(articles, ctx.rubric, ctx.datanetId, strategy, {
        model: deps.model,
        generate: deps.generate as never,
      })
      return filterNovel(cands, ctx.existingPodNames ?? [])
    },
  }
}
