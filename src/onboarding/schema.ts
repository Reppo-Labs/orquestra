// src/onboarding/schema.ts
import { z } from 'zod'
import { Strictness } from '../config/schema.js'
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
  // Display name the node registers on the Reppo platform (leaderboard, stats).
  // Optional: absent/blank → orquestra-<wallet slice> default at registration.
  nodeName: z.string().trim().max(64).optional(),
})

export type ValidateResult = { ok: true; answers: OnboardingAnswers } | { ok: false; error: string }

/** Validate raw answers two ways: shape (zod) + full StrategyConfig assembly. */
export function validateAnswers(raw: unknown): ValidateResult {
  const parsed = OnboardingAnswersSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  try {
    buildStrategyConfig(parsed.data) // throws if the assembled config is invalid
    return { ok: true, answers: parsed.data }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
