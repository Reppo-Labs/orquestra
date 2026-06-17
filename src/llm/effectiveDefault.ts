import type { LlmProvider } from './model.js'

/** Resolve the node default model: the dashboard-selected `config.defaultModel` when its
 *  provider has an env key, else the env LLM_PROVIDER default. Keys come ONLY from the
 *  env-built registry (ADR 0002). `key === ''` means even the env default is unkeyed —
 *  the caller treats that as "default model unavailable".
 *
 *  Why fall back instead of erroring on a keyless config default: a stale dashboard pick
 *  (its provider's key later removed from env) must never brick scoring + the assistant. */
export function effectiveDefault(args: {
  configDefault?: { provider: LlmProvider; model: string }
  registry: Map<LlmProvider, string>
  envProvider: LlmProvider
  envModel: string
}): { provider: LlmProvider; model: string; key: string; usedFallback?: string } {
  const { configDefault, registry, envProvider, envModel } = args
  if (configDefault) {
    const k = registry.get(configDefault.provider)
    if (k) return { provider: configDefault.provider, model: configDefault.model, key: k }
    return {
      provider: envProvider,
      model: envModel,
      key: registry.get(envProvider) ?? '',
      usedFallback: `default provider ${configDefault.provider} has no API key; using env default ${envProvider}`,
    }
  }
  return { provider: envProvider, model: envModel, key: registry.get(envProvider) ?? '' }
}
