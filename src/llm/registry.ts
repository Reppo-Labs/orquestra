// src/llm/registry.ts — build the provider key registry from env at startup.
// Keys are read from the ENVIRONMENT ONLY (never the dashboard, never persisted,
// never logged). The map's keys are `availableProviders`. Per-provider LLM_KEY_*
// vars win; LLM_PROVIDER + LLM_API_KEY register the DEFAULT provider's key only
// when that provider has no explicit LLM_KEY_* (back-compat: an operator who set
// just those keeps working).
import { LlmProviderEnum, type LlmProvider } from './model.js'

// Partial: `anthropic-oauth` has NO env key — its credential is a stored token set in
// DATA_DIR, and its availability is decided by hasOAuthCredential, not this registry.
const ENV_BY_PROVIDER: Partial<Record<LlmProvider, string>> = {
  anthropic: 'LLM_KEY_ANTHROPIC',
  openai: 'LLM_KEY_OPENAI',
  google: 'LLM_KEY_GOOGLE',
  virtuals: 'LLM_KEY_VIRTUALS',
  surplus: 'LLM_KEY_SURPLUS',
  usepod: 'LLM_KEY_USEPOD',
}

type Env = Record<string, string | undefined>

/** Map<provider, apiKey> from env. Blank/whitespace values are ignored. */
export function buildProviderKeyRegistry(env: Env): Map<LlmProvider, string> {
  const reg = new Map<LlmProvider, string>()
  // 1) per-provider explicit keys (authoritative).
  for (const provider of LlmProviderEnum.options) {
    const envName = ENV_BY_PROVIDER[provider]
    if (!envName) continue // e.g. anthropic-oauth: not env-keyed
    const v = env[envName]?.trim()
    if (v) reg.set(provider, v)
  }
  // 2) back-compat default: LLM_PROVIDER + LLM_API_KEY → that provider, only if it has
  //    no explicit LLM_KEY_* above. Unknown LLM_PROVIDER (or blank key) is ignored.
  const defKey = env.LLM_API_KEY?.trim()
  const defProviderRaw = env.LLM_PROVIDER?.trim() || 'anthropic'
  const defProvider = LlmProviderEnum.safeParse(defProviderRaw)
  // Only env-keyed providers are eligible for the back-compat default. anthropic-oauth has
  // no env key (ENV_BY_PROVIDER lacks it), so LLM_PROVIDER=anthropic-oauth + LLM_API_KEY must
  // NOT register it here — its availability is decided solely by hasOAuthCredential.
  if (defKey && defProvider.success && ENV_BY_PROVIDER[defProvider.data] && !reg.has(defProvider.data)) {
    reg.set(defProvider.data, defKey)
  }
  return reg
}
