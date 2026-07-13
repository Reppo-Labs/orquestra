// src/adapter/sports/index.ts
import type { LanguageModel } from 'ai'
import { DEFAULT_FEEDS, fetchFeed as liveFetchFeed, freshItems, type FeedItem } from './feeds.js'
import { synthesizeSignals, type SportsStrategy } from './signal.js'
import { filterNovel } from '../dedup.js'
import { filterNovelSemantic } from '../semanticDedup.js'
import { str, num, strArray } from '../params.js'
import type { DatanetAdapter, CandidatePod, AdapterContext } from '../types.js'

export interface SportsDeps {
  /** Live model resolver, called at each discover() — NOT a model frozen at construction,
   *  so a dashboard default-model change applies on the next cycle without a restart.
   *  undefined ⇒ no LLM (tests inject `generate`; semantic dedup no-ops). */
  getModel?: () => LanguageModel | undefined
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

/** Operator-tunable sports params, as they arrive on AdapterContext.strategy
 *  (config datanets[id].adapterParams merged with the live brief). */
export interface SportsParams extends Partial<SportsStrategy> {
  feeds?: string[]
  maxAgeHours?: number
}

/** Lenient parse of the raw strategy object — the validation lives HERE, not in the
 *  wiring: a wrong-typed field (operator-edited config) is dropped so the adapter's
 *  defaults apply, never crashing discovery (a bare-string `feeds` used to hit
 *  `feeds.join` and throw the whole datanet's mint) or poisoning the prompt. */
export function parseSportsParams(raw: Record<string, unknown> | undefined): SportsParams {
  if (!raw) return {}
  const out: SportsParams = {}
  const focus = str(raw.focus)
  if (focus !== undefined) out.focus = focus
  const angle = str(raw.angle)
  if (angle !== undefined) out.angle = angle
  const brief = str(raw.brief)
  if (brief !== undefined) out.brief = brief
  const topN = num(raw.topN)
  if (topN !== undefined) out.topN = topN
  const minSignal = num(raw.minSignal)
  if (minSignal !== undefined) out.minSignal = minSignal
  const feeds = strArray(raw.feeds)
  if (feeds !== undefined) out.feeds = feeds
  const maxAgeHours = num(raw.maxAgeHours)
  if (maxAgeHours !== undefined) out.maxAgeHours = maxAgeHours
  return out
}

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
      const s = parseSportsParams(ctx.strategy)
      const strategy: SportsStrategy = {
        ...STRATEGY_DEFAULTS, ...s,
        topN: s.topN ?? ctx.topN ?? STRATEGY_DEFAULTS.topN,
      }
      const feeds = s.feeds ?? deps.feeds ?? DEFAULT_FEEDS
      const maxAgeHours = s.maxAgeHours ?? deps.maxAgeHours ?? 48
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
      // Resolve the model LIVE, once per discover — synthesis and semantic dedup share it.
      const model = deps.getModel?.()
      const cands = await synthesizeSignals(fresh, ctx.rubric, ctx.datanetId, strategy, {
        model,
        generate: deps.generate as never,
      })
      const novel = filterNovel(cands, ctx.existingPodNames ?? [])
      return filterNovelSemantic(novel, ctx.existingPodNames ?? [], { model })
    },
  }
}
