// src/adapter/sports/index.ts
import type { LanguageModel } from 'ai'
import { DEFAULT_FEEDS, fetchFeed as liveFetchFeed, freshItems, type FeedItem } from './feeds.js'
import { synthesizeSignals, type SportsStrategy } from './signal.js'
import { filterNovel } from '../dedup.js'
import { filterNovelSemantic } from '../semanticDedup.js'
import type { DatanetAdapter, CandidatePod, AdapterContext } from '../types.js'

export interface SportsDeps {
  model?: LanguageModel
  fetchFeed?: (url: string) => Promise<FeedItem[]>
  generate?: (args: { system: string; prompt: string }) => Promise<{ signals: unknown[] }>
  feeds?: string[]
  maxAgeHours?: number
  /** Don't refetch feeds more than once per interval (default 30 min) — armed only
   *  on a successful fetch so a transient failure retries next cycle. */
  minFetchIntervalMs?: number
  /** injectable clock for tests. */
  now?: () => number
}

const STRATEGY_DEFAULTS: SportsStrategy = { focus: 'major-league sports', angle: 'balanced', brief: '', topN: 4, minSignal: 7 }
const DEFAULT_MIN_FETCH_INTERVAL_MS = 30 * 60_000

/** Sports Signals adapter (id "sports") — curates analyst takes from RSS analysis
 *  feeds for datanet 11. Mirrors the gdelt shape; personalized via ctx.strategy. */
export function createSportsAdapter(deps: SportsDeps = {}): DatanetAdapter {
  const fetchFeed = deps.fetchFeed ?? liveFetchFeed
  const minInterval = deps.minFetchIntervalMs ?? DEFAULT_MIN_FETCH_INTERVAL_MS
  const now = deps.now ?? (() => Date.now())
  const lastFetchAt = new Map<string, number>() // keyed by feed-set fingerprint
  return {
    id: 'sports',
    async discover(ctx: AdapterContext): Promise<CandidatePod[]> {
      const s = ctx.strategy as Partial<SportsStrategy> & { feeds?: string[]; maxAgeHours?: number } | undefined
      const strategy: SportsStrategy = {
        ...STRATEGY_DEFAULTS, ...s,
        topN: s?.topN ?? ctx.topN ?? STRATEGY_DEFAULTS.topN,
      }
      const feeds = s?.feeds ?? deps.feeds ?? DEFAULT_FEEDS
      const maxAgeHours = s?.maxAgeHours ?? deps.maxAgeHours ?? 48
      const key = feeds.join('|')

      const last = lastFetchAt.get(key)
      const t = now()
      if (last !== undefined && t - last < minInterval) {
        console.error(`orquestra: sports fetch skipped — throttled (last success ${Math.round((t - last) / 1000)}s ago, min ${Math.round(minInterval / 1000)}s)`)
        return []
      }

      // Per-feed tolerance: one feed's failure never blanks the others.
      const results = await Promise.allSettled(feeds.map((u) => fetchFeed(u)))
      const items: FeedItem[] = []
      let okFeeds = 0
      for (const [i, r] of results.entries()) {
        if (r.status === 'fulfilled') { okFeeds++; items.push(...r.value) }
        else console.error(`orquestra: sports feed failed (${feeds[i]}) — ${r.reason instanceof Error ? r.reason.message.split('\n')[0] : String(r.reason)}`)
      }
      // ALL feeds down → no candidates this cycle; throttle NOT armed (retry next cycle).
      if (okFeeds === 0) return []
      lastFetchAt.set(key, t) // only successful fetches count toward the throttle

      const fresh = freshItems(items, maxAgeHours)
      if (fresh.length === 0) return []
      const cands = await synthesizeSignals(fresh, ctx.rubric, ctx.datanetId, strategy, {
        model: deps.model,
        generate: deps.generate as never,
      })
      const novel = filterNovel(cands, ctx.existingPodNames ?? [])
      return filterNovelSemantic(novel, ctx.existingPodNames ?? [], { model: deps.model })
    },
  }
}
