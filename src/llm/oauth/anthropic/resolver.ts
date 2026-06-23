// src/llm/oauth/anthropic/resolver.ts — the composed ModelResolver that teaches the
// existing resolution seam about subscription OAuth without changing any caller. The
// registry stores a non-empty SENTINEL for `anthropic-oauth` (so effectiveDefault /
// resolveScoringModel treat it as "keyed" and don't skip); this resolver discards that
// sentinel and supplies the live tokenProvider instead. Every other provider is passed
// through untouched.
import { resolveModel, type LlmProvider, type ResolveModelOpts } from '../../model.js'
import type { ModelResolver } from '../../resolveScoringModel.js'
import type { LanguageModel } from 'ai'

/** Non-empty placeholder stored in the key registry for `anthropic-oauth`; its value is
 *  never used (the resolver swaps it for a Bearer token), only its truthiness matters. */
export const OAUTH_KEY_SENTINEL = 'oauth'

type InnerResolve = (provider: LlmProvider, apiKey: string, model?: string, opts?: ResolveModelOpts) => LanguageModel

/** Build a ModelResolver that special-cases `anthropic-oauth` (fresh token per request)
 *  and delegates all other providers to the standard resolveModel. */
export function oauthAwareResolver(tokenProvider: () => Promise<string>, resolve: InnerResolve = resolveModel): ModelResolver {
  return (provider, apiKey, model) =>
    provider === 'anthropic-oauth'
      ? resolve(provider, '', model, { tokenProvider })
      : resolve(provider, apiKey, model)
}
