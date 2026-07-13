// src/llm/resolveScoringModel.ts — pure per-datanet TEXT scoring-model resolution.
// Returns { model } to score, or { skip } with an operator-readable reason (reused by
// the cycle's per-datanet skip/record mechanism — fail-closed, never aborts a cycle).
// This resolver knows nothing about video: a video pod's per-pod Gemini resolution is
// owned by the VideoPodPipeline (src/voter/videoPipeline.ts), which also owns detection,
// the per-cycle budget, ingest, and cleanup ordering.
import type { LanguageModel } from 'ai'
import { resolveModel, type LlmProvider } from './model.js'

export interface ResolveScoringInput {
  /** The datanet's explicit override (config.datanets[id].model), if any. */
  policyModel?: { provider: LlmProvider; model: string }
  /** provider → apiKey, from buildProviderKeyRegistry. */
  registry: Map<LlmProvider, string>
  /** Node default provider/model (LLM_PROVIDER / its DEFAULT_MODEL). */
  defaultProvider: LlmProvider
  defaultModel: string
}

export type ScoringModelResult = { model: LanguageModel } | { skip: string }

/** Builds the SDK model from provider + key + slug. Defaults to the real resolveModel;
 *  injectable so tests can assert the resolved provider/slug without an SDK round-trip. */
export type ModelResolver = (provider: LlmProvider, apiKey: string, model?: string) => LanguageModel

export function resolveScoringModel(input: ResolveScoringInput, resolve: ModelResolver = resolveModel): ScoringModelResult {
  const { policyModel, registry, defaultProvider, defaultModel } = input

  // 1) explicit per-datanet override.
  if (policyModel) {
    const key = registry.get(policyModel.provider)
    if (!key) return { skip: `no API key for ${policyModel.provider} (this datanet is set to ${policyModel.provider}/${policyModel.model})` }
    return { model: resolve(policyModel.provider, key, policyModel.model) }
  }

  // 2) no override → node default.
  const key = registry.get(defaultProvider)
  if (!key) return { skip: `no API key for the node default provider (${defaultProvider})` }
  return { model: resolve(defaultProvider, key, defaultModel) }
}
