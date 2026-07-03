// src/llm/model.ts
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { wrapLanguageModel, type LanguageModel } from 'ai'
import { z } from 'zod'
import { withUsageTracking } from './usage.js'

export type LlmProvider = 'anthropic' | 'openai' | 'google' | 'surplus' | 'virtuals' | 'usepod' | 'anthropic-oauth'

/** anthropic-beta opt-in that authorizes OAuth (subscription) bearer tokens on the
 *  Messages API. Sent on every anthropic-oauth request alongside `Authorization: Bearer`. */
export const OAUTH_BETA = 'oauth-2025-04-20'

/** REQUIRED first system block for subscription OAuth tokens. Anthropic gates these tokens to
 *  Claude-Code-shaped requests: without this exact preamble as the first system block the API
 *  returns 429 "Error". (The official CLI sends it; we hit the API directly so we inject it.) */
export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."

type SystemBlock = { type: 'text'; text: string }

/** Prepend the Claude Code preamble as the first system block, preserving the caller's own
 *  system prompt as a following block. Idempotent (won't double-prepend). */
function withClaudeCodeSystem(system: unknown): SystemBlock[] {
  const cc: SystemBlock = { type: 'text', text: CLAUDE_CODE_SYSTEM }
  if (system == null || system === '') return [cc]
  if (typeof system === 'string') return [cc, { type: 'text', text: system }]
  if (Array.isArray(system)) {
    const first = system[0] as SystemBlock | undefined
    if (first && first.text === CLAUDE_CODE_SYSTEM) return system as SystemBlock[]
    return [cc, ...(system as SystemBlock[])]
  }
  return [cc]
}

/** Wrap a fetch so each request authenticates with a FRESH subscription OAuth token
 *  instead of an API key: drop `x-api-key`, set `Authorization: Bearer <token>`, add the
 *  oauth beta (merged with any beta the SDK set), and inject the Claude Code system preamble
 *  the token requires. The token is fetched per call so an expired token never produces a
 *  stale resolved model. */
export function makeOAuthFetch(tokenProvider: () => Promise<string>, baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const token = await tokenProvider()
    const headers = new Headers(init?.headers)
    headers.delete('x-api-key')
    headers.set('authorization', `Bearer ${token}`)
    const existingBeta = headers.get('anthropic-beta')
    const betas = existingBeta ? existingBeta.split(',').map((s) => s.trim()).filter(Boolean) : []
    if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA)
    headers.set('anthropic-beta', betas.join(','))
    // Inject the required Claude Code system preamble into the Messages request body.
    let body = init?.body
    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body)
        if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { messages?: unknown }).messages)) {
          ;(parsed as { system?: unknown }).system = withClaudeCodeSystem((parsed as { system?: unknown }).system)
          body = JSON.stringify(parsed)
        }
      } catch {
        // not a JSON body — leave untouched
      }
    }
    const response = await baseFetch(input, { ...init, headers, body })
    // A 401 means the stored OAuth token has expired or been revoked.
    // Throw before the SDK parses the body so operators see a recovery hint, not a raw auth error.
    if (response.status === 401) {
      throw new Error('Anthropic OAuth token expired or revoked — run `orquestra login-anthropic` to refresh, then restart the node')
    }
    return response
  }
}

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

/** True when a provider rejected `temperature` (deprecated/unsupported for that model).
 *  Requires the word "temperature" PLUS a rejection word, so unrelated errors don't match. */
export function isTemperatureUnsupportedError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return msg.includes('temperature') && /(deprecat|not supported|unsupported|does not support|isn't supported|not allowed)/.test(msg)
}

/** Module-level latch of modelIds known to reject `temperature` — so a model that
 *  rejected it once is stripped PROACTIVELY on later calls (only the first call eats a
 *  failed round-trip). */
const rejectsTemperature = new Set<string>()

/** Wrap a model so `temperature` is dropped for models that don't support it — detected
 *  at runtime (the SDK forces temperature:0; some models reject it). Error-driven + latched:
 *  the first rejecting call retries stripped and records the modelId; later calls strip up
 *  front. Models that accept temperature are untouched (keep the deterministic 0). */
export function withTemperatureFallback(model: LanguageModel): LanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate, params, model: m }) => {
        if (params.temperature != null && rejectsTemperature.has(m.modelId)) {
          return m.doGenerate({ ...params, temperature: undefined })
        }
        try { return await doGenerate() }
        catch (e) {
          if (isTemperatureUnsupportedError(e) && params.temperature != null) {
            rejectsTemperature.add(m.modelId)
            return await m.doGenerate({ ...params, temperature: undefined })
          }
          throw e
        }
      },
      wrapStream: async ({ doStream, params, model: m }) => {
        if (params.temperature != null && rejectsTemperature.has(m.modelId)) {
          return m.doStream({ ...params, temperature: undefined })
        }
        try { return await doStream() }
        catch (e) {
          if (isTemperatureUnsupportedError(e) && params.temperature != null) {
            rejectsTemperature.add(m.modelId)
            return await m.doStream({ ...params, temperature: undefined })
          }
          throw e
        }
      },
    },
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
  google: 'gemini-3.1-pro-preview',
  surplus: 'claude-opus-4.8',
  virtuals: 'claude-opus-4-8',
  usepod: 'deepseek-v3.2',
  // subscription OAuth — same Anthropic models as the key-auth provider.
  'anthropic-oauth': 'claude-opus-4-7',
}

/** The LlmProvider union as a Zod enum. The .options array MUST stay in sync with
 *  the `LlmProvider` type above — model.test.ts asserts it. Config + dashboard use
 *  this to validate a provider string. */
export const LlmProviderEnum = z.enum(['anthropic', 'openai', 'google', 'surplus', 'virtuals', 'usepod', 'anthropic-oauth'])

/** Per-provider seed model slugs surfaced by the dashboard picker. Slugs drift, so the
 *  picker also allows free-text — this is only a convenience list, never authoritative
 *  (an unknown slug fails at request time, not here). Always includes DEFAULT_MODEL[p]. */
export const KNOWN_MODELS: Record<LlmProvider, string[]> = {
  anthropic: ['claude-opus-4-7', 'claude-sonnet-4-5'],
  openai: ['gpt-5.2', 'gpt-5.2-mini'],
  google: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview'],
  surplus: ['claude-opus-4.8'],
  virtuals: ['claude-opus-4-8', 'gemini-3-flash-preview'],
  usepod: ['deepseek-v3.2', 'qwen-3.5', 'llama-4', 'mistral', 'glm-5.1'],
  'anthropic-oauth': ['claude-opus-4-7', 'claude-sonnet-4-5'],
}

/** Extra resolution inputs that don't fit the (provider, apiKey) shape. */
export interface ResolveModelOpts {
  /** Required for `anthropic-oauth`: yields a fresh subscription access token per request. */
  tokenProvider?: () => Promise<string>
}

export function resolveModel(provider: LlmProvider, apiKey: string, model?: string, opts?: ResolveModelOpts): LanguageModel {
  let built: LanguageModel
  switch (provider) {
    case 'anthropic':
      built = createAnthropic({ apiKey })(model ?? DEFAULT_MODEL.anthropic)
      break
    case 'anthropic-oauth': {
      // Subscription auth: no API key. A custom fetch swaps `x-api-key` for a fresh
      // `Authorization: Bearer` + the oauth beta on every call (see makeOAuthFetch).
      if (!opts?.tokenProvider) throw new Error('anthropic-oauth requires a tokenProvider (run `orquestra login-anthropic`)')
      // Non-empty placeholder key: the SDK's loadApiKey throws on an empty key BEFORE our
      // fetch runs, so '' would brick oauth. makeOAuthFetch deletes the resulting x-api-key
      // header and substitutes the Bearer token, so this value never reaches Anthropic.
      built = createAnthropic({ apiKey: 'oauth', fetch: makeOAuthFetch(opts.tokenProvider) })(model ?? DEFAULT_MODEL['anthropic-oauth'])
      break
    }
    case 'openai':
      built = createOpenAI({ apiKey })(model ?? DEFAULT_MODEL.openai)
      break
    case 'google':
      built = createGoogleGenerativeAI({ apiKey })(model ?? DEFAULT_MODEL.google)
      break
    case 'surplus':
      built = createOpenAI({ apiKey, baseURL: SURPLUS_BASE_URL })(model ?? DEFAULT_MODEL.surplus)
      break
    case 'virtuals':
      // OpenAI-compatible: Bearer acp- key, POSTs to /v1/chat/completions.
      built = createOpenAI({ apiKey, baseURL: VIRTUALS_BASE_URL })(model ?? DEFAULT_MODEL.virtuals)
      break
    case 'usepod':
      // OpenAI-compatible, but the auth token is in the URL PATH (api_key unused).
      // The configured key IS the usepod token; interpolate it into the base URL.
      built = createOpenAI({
        apiKey: 'unused',
        baseURL: usepodBaseURL(apiKey),
      })(model ?? DEFAULT_MODEL.usepod)
      break
    default: {
      const _exhaustive: never = provider
      throw new Error(`unknown LLM provider: ${String(_exhaustive)}`)
    }
  }
  // Strip `temperature` for ANY model that rejects it (error-driven + latched). Models
  // that accept it (Claude/GPT/Gemini) keep the deterministic temperature:0 the SDK supplies.
  // withUsageTracking feeds the per-cycle LLM cost estimate on the dashboard — every
  // resolved model reports token usage, so all call sites are covered here, once.
  return withUsageTracking(withTemperatureFallback(built))
}
