// src/llm/resolveScoringModel.ts — pure per-datanet/per-pod scoring-model resolution.
// Returns { model } to score, or { skip } with an operator-readable reason (reused by
// the cycle's per-datanet skip/record mechanism — fail-closed, never aborts a cycle).
// The video path is LIVE: datanet-level resolution (wiring.ts voteScorerFor) passes
// isVideo=false as a model-resolution seam — it picks the text scorer's model, not a
// feature flag. Video pods are detected + marked in wiring's getPodsAndFilter, and the
// per-pod path (voter/score.ts, via ScorerModelCtx) re-resolves with isVideo=true so a
// video pod scores on a Gemini model; panel/scorers.ts bypasses the panel for them.
import type { LanguageModel } from 'ai'
import { resolveModel, type LlmProvider } from './model.js'

/** Native video (motion + audio) only works via @ai-sdk/google. See spec §"Model-capability finding". */
export const VIDEO_DEFAULT_PROVIDER: LlmProvider = 'google'
export const VIDEO_DEFAULT_MODEL = 'gemini-3.1-pro-preview'

export interface ResolveScoringInput {
  /** The datanet's explicit override (config.datanets[id].model), if any. */
  policyModel?: { provider: LlmProvider; model: string }
  /** True for the per-pod video re-resolution (voter/score.ts). Datanet-level callers
   *  (wiring.ts voteScorerFor) always pass false — a model-resolution seam, not a
   *  feature flag: the video path is live. */
  isVideo: boolean
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
  const { policyModel, isVideo, registry, defaultProvider, defaultModel } = input

  // 1) explicit per-datanet override.
  if (policyModel) {
    if (isVideo && policyModel.provider !== 'google') {
      return { skip: `video pod needs a Gemini model; this datanet is set to ${policyModel.provider}/${policyModel.model}` }
    }
    const key = registry.get(policyModel.provider)
    if (!key) return { skip: `no API key for ${policyModel.provider} (this datanet is set to ${policyModel.provider}/${policyModel.model})` }
    return { model: resolve(policyModel.provider, key, policyModel.model) }
  }

  // 2) no override + video → Gemini default.
  if (isVideo) {
    const key = registry.get(VIDEO_DEFAULT_PROVIDER)
    if (!key) return { skip: 'video scoring needs a Google API key (set LLM_KEY_GOOGLE)' }
    return { model: resolve(VIDEO_DEFAULT_PROVIDER, key, VIDEO_DEFAULT_MODEL) }
  }

  // 3) no override + text → node default.
  const key = registry.get(defaultProvider)
  if (!key) return { skip: `no API key for the node default provider (${defaultProvider})` }
  return { model: resolve(defaultProvider, key, defaultModel) }
}
