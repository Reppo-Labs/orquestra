// src/onboarding/schema.ts
import { z } from 'zod'
import { Strictness } from '../config/schema.js'
import { LlmProviderEnum, type LlmProvider } from '../llm/model.js'
import { buildStrategyConfig } from './build.js'
import type { OnboardingAnswers } from './types.js'

/** LLMs routinely stringify nested arrays/objects in tool calls (observed live:
 *  update_draft arrived with datanets as a JSON string and hard-failed the
 *  interview). Parse a string that looks like JSON before validating; anything
 *  unparseable falls through to the inner schema's own error. */
const jsonLenient = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => {
    if (typeof v === 'string') {
      try { return JSON.parse(v) } catch { return v }
    }
    return v
  }, inner)

export const OnboardingAnswersSchema = z.object({
  datanets: jsonLenient(z.array(z.object({
    id: z.string(),
    vote: z.boolean(),
    mint: z.boolean(),
    strictness: Strictness,
    adapter: z.string().optional(),
    // Free-form per-adapter params, mirroring config/schema.ts: each adapter
    // parses its own params leniently (parseGdeltParams/parseSherwoodParams…).
    // A closed shape here silently STRIPPED non-gdelt keys (sherwood's brief/
    // minSelfScore) before they ever reached the config.
    adapterParams: jsonLenient(z.record(z.string(), z.unknown())).optional(),
  }))),
  lockReppo: z.number().nonnegative(),
  // 0 allowed for no-lock (robinhood) answers; the assembled StrategyConfig
  // still enforces duration > 0 whenever lockReppo > 0 (config/schema.ts).
  lockDurationDays: z.number().int().nonnegative(),
  voteRateMaxPerCycle: z.number().int().nonnegative(),
  mintReppoMax: z.number().nonnegative(),
  horizonDays: z.number().int().positive(),
  cadenceHours: z.number().min(0.1), // fractional ok (0.5 = 30 min); floor matches config schema
  notes: z.string().default(''),
  // Node default LLM model. Optional: absent → the env LLM_PROVIDER default. The
  // provider must be a KNOWN provider here; whether it is actually KEYED on this node
  // is a separate, env-dependent check (see checkProviderAvailable) because the shape
  // schema is also the LLM tool schema and must stay environment-independent.
  defaultModel: jsonLenient(z.object({
    provider: LlmProviderEnum,
    model: z.string().trim().min(1),
  })).optional(),
  // Display name the node registers on the Reppo platform (leaderboard, stats).
  // Optional: absent/blank → orquestra-<wallet slice> default at registration.
  nodeName: z.string().trim().max(64).optional(),
})

export type ValidateResult = { ok: true; answers: OnboardingAnswers } | { ok: false; error: string }

/** Reject a default model whose provider has no credential on THIS node, so onboarding
 *  cannot persist a model the runtime would silently fall back away from (effectiveDefault
 *  would swap it for the env default every cycle — exactly the "it looks saved, it isn't"
 *  class of bug this check exists to prevent). Rejected loudly rather than dropped: a
 *  silent drop is what made the original bug invisible.
 *
 *  FAIL-OPEN on an UNKNOWN provider list (undefined/empty): availability comes from the
 *  env key registry, and a caller that cannot enumerate it (CLI without wiring, tests)
 *  must not have every model choice refused. An unread availability is not "unavailable". */
export function checkProviderAvailable(
  defaultModel: { provider: LlmProvider } | undefined,
  availableProviders?: LlmProvider[],
): { ok: true } | { ok: false; error: string } {
  if (!defaultModel || !availableProviders?.length) return { ok: true }
  if (availableProviders.includes(defaultModel.provider)) return { ok: true }
  return {
    ok: false,
    error: `defaultModel.provider: ${defaultModel.provider} has no API key on this node — ` +
      `set LLM_KEY_${defaultModel.provider.toUpperCase().replace(/-/g, '_')} in the environment, ` +
      `or choose one of: ${availableProviders.join(', ')}`,
  }
}

/** Validate raw answers three ways: shape (zod), default-model provider availability on
 *  this node, and full StrategyConfig assembly. `availableProviders` is the env key
 *  registry's providers; omit it where availability is unknown (see checkProviderAvailable). */
export function validateAnswers(raw: unknown, availableProviders?: LlmProvider[]): ValidateResult {
  const parsed = OnboardingAnswersSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  const avail = checkProviderAvailable(parsed.data.defaultModel, availableProviders)
  if (!avail.ok) return { ok: false, error: avail.error }
  try {
    buildStrategyConfig(parsed.data) // throws if the assembled config is invalid
    return { ok: true, answers: parsed.data }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
