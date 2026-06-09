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
}

const STRATEGY_DEFAULTS: GdeltStrategy = { focus: 'global geopolitical flashpoints', angle: 'balanced', brief: '', topN: 8, minImportance: 7 }

/** GDELT source adapter (id "gdelt") — reusable across news/claims datanets; personalized
 *  per (datanet, operator) via ctx.strategy. */
export function createGdeltAdapter(deps: GdeltDeps = {}): DatanetAdapter {
  const fetchEvents = deps.fetchEvents ?? fetchGeoEvents
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
      // A fetch failure (GDELT 429 rate limit, network blip) means no candidates THIS
      // cycle — it must not throw into runCycle and mark the whole datanet errored
      // (votes already executed would be reported as a datanet failure). Next cycle
      // retries naturally.
      let articles: GeoArticle[]
      try {
        articles = await fetchEvents(q)
      } catch (e) {
        console.error(`orquestra: gdelt fetch failed (skipping mint discovery this cycle) — ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
        return []
      }
      if (articles.length === 0) return []
      const cands = await synthesizeClaims(articles, ctx.rubric, ctx.datanetId, strategy, {
        model: deps.model,
        generate: deps.generate as never,
      })
      return filterNovel(cands, ctx.existingPodNames ?? [])
    },
  }
}
