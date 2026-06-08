// src/adapter/gdelt/index.ts
import type { LanguageModel } from 'ai'
import { fetchGeoEvents, type GeoArticle, type GdeltQuery } from './gdelt.js'
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
      const strategy: GdeltStrategy = {
        ...STRATEGY_DEFAULTS, ...deps.defaults,
        ...(ctx.strategy as Partial<GdeltStrategy> | undefined),
        topN: ctx.topN || STRATEGY_DEFAULTS.topN,
      }
      const q: GdeltQuery = {
        query: deps.defaults?.query ?? strategy.focus,
        timespanHours: deps.defaults?.timespanHours ?? 24,
        maxRecords: deps.defaults?.maxRecords ?? 75,
      }
      const articles = await fetchEvents(q)
      if (articles.length === 0) return []
      const cands = await synthesizeClaims(articles, ctx.rubric, ctx.datanetId, strategy, {
        model: deps.model,
        generate: deps.generate as never,
      })
      return filterNovel(cands, ctx.existingPodNames ?? [])
    },
  }
}
