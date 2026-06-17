// src/llm/model.ts
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { wrapLanguageModel, type LanguageModel, type LanguageModelV1CallOptions } from 'ai'
import { z } from 'zod'

export type LlmProvider = 'anthropic' | 'openai' | 'google' | 'surplus' | 'virtuals' | 'usepod'

/** Surplus Intelligence — an OpenAI-compatible discounted-inference marketplace
 *  (https://www.surplusintelligence.ai). Bearer `inf_…` API key. The OpenAI
 *  client appends `/chat/completions` to this base URL. */
const SURPLUS_BASE_URL = 'https://www.surplusintelligence.ai/api/inference/v1'

/** Virtuals — an OpenAI-compatible inference gateway (https://compute.virtuals.io).
 *  Bearer `acp-…` (ACP) key; the OpenAI client appends `/chat/completions` to this
 *  base URL. Settles via the Agent Commerce Protocol (no per-call USDC), so it
 *  sidesteps marketplace USDC minimums. Model slugs are bare (e.g. `claude-opus-4-8`);
 *  list them at GET /v1/models. */
const VIRTUALS_BASE_URL = 'https://compute.virtuals.io/v1'

/** usepod — a decentralized, OpenAI-compatible inference marketplace
 *  (https://usepod.ai). The auth token is carried in the URL PATH, not a header:
 *  the base URL is `<prefix>/<token>/v1` and the OpenAI client's apiKey is unused.
 *  Obtain a token from `POST https://api.usepod.ai/register` (prepaid USDC balance).
 *  Model ids are canonical/host-advertised (e.g. `deepseek-v3.2`); list at
 *  GET <prefix>/<token>/v1/models. */
const USEPOD_BASE_PREFIX = 'https://api.usepod.ai/proxy'

/** usepod base URL with the auth token in the PATH: `<prefix>/<token>/v1`. Exported
 *  for testing (the wrapped model hides the openai client's internal `config.url`). */
export const usepodBaseURL = (token: string): string => `${USEPOD_BASE_PREFIX}/${token}/v1`

/** Drop `temperature` from a model-call's params. The AI SDK v4 core forces
 *  `temperature: 0` on every call (its own "TODO v5 remove default 0 for temperature"),
 *  and some usepod-hosted open-weight models (e.g. deepseek) reject it with
 *  "temperature is deprecated for this model". Exported for testing. */
export const stripTemperature = (params: LanguageModelV1CallOptions): LanguageModelV1CallOptions =>
  ({ ...params, temperature: undefined })

/** Wrap a model so `temperature` is stripped before the provider request. Scoped to
 *  usepod only — the REPPO-side providers (Claude/GPT/Gemini) want the deterministic
 *  temperature:0 the SDK supplies for scoring. */
function dropTemperature(model: LanguageModel): LanguageModel {
  return wrapLanguageModel({
    model,
    middleware: { transformParams: async ({ params }) => stripTemperature(params) },
  })
}

/** Resolve a model from any supported provider + the user's API key.
 *  "Optimize for inference" = the node runs its OWN inference on the user's
 *  chosen provider; it never sells compute. */
// Default model slugs per provider. NOTE: provider slugs change over time —
// update these (or always pass an explicit `model`) when providers rename models;
// an unknown slug fails at request time, not build time.
export const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-5.2',
  google: 'gemini-3-pro',
  surplus: 'claude-opus-4.8',
  virtuals: 'claude-opus-4-8',
  usepod: 'deepseek-v3.2',
}

/** The LlmProvider union as a Zod enum. The .options array MUST stay in sync with
 *  the `LlmProvider` type above — model.test.ts asserts it. Config + dashboard use
 *  this to validate a provider string. */
export const LlmProviderEnum = z.enum(['anthropic', 'openai', 'google', 'surplus', 'virtuals', 'usepod'])

/** Per-provider seed model slugs surfaced by the dashboard picker. Slugs drift, so the
 *  picker also allows free-text — this is only a convenience list, never authoritative
 *  (an unknown slug fails at request time, not here). Always includes DEFAULT_MODEL[p]. */
export const KNOWN_MODELS: Record<LlmProvider, string[]> = {
  anthropic: ['claude-opus-4-7', 'claude-sonnet-4-5'],
  openai: ['gpt-5.2', 'gpt-5.2-mini'],
  google: ['gemini-3-pro', 'gemini-3-flash'],
  surplus: ['claude-opus-4.8'],
  virtuals: ['claude-opus-4-8', 'gemini-3-flash-preview'],
  usepod: ['deepseek-v3.2', 'qwen-3.5', 'llama-4', 'mistral', 'glm-5.1'],
}

export function resolveModel(provider: LlmProvider, apiKey: string, model?: string): LanguageModel {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(model ?? DEFAULT_MODEL.anthropic)
    case 'openai':
      return createOpenAI({ apiKey })(model ?? DEFAULT_MODEL.openai)
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(model ?? DEFAULT_MODEL.google)
    case 'surplus':
      return createOpenAI({ apiKey, baseURL: SURPLUS_BASE_URL })(model ?? DEFAULT_MODEL.surplus)
    case 'virtuals':
      // OpenAI-compatible: Bearer acp- key, POSTs to /v1/chat/completions.
      return createOpenAI({ apiKey, baseURL: VIRTUALS_BASE_URL })(model ?? DEFAULT_MODEL.virtuals)
    case 'usepod':
      // OpenAI-compatible, but the auth token is in the URL PATH (api_key unused).
      // The configured key IS the usepod token; interpolate it into the base URL.
      // dropTemperature: usepod's open-weight models (e.g. deepseek) reject the
      // temperature:0 the AI SDK forces on every call.
      return dropTemperature(createOpenAI({
        apiKey: 'unused',
        baseURL: usepodBaseURL(apiKey),
      })(model ?? DEFAULT_MODEL.usepod))
    default: {
      const _exhaustive: never = provider
      throw new Error(`unknown LLM provider: ${String(_exhaustive)}`)
    }
  }
}
