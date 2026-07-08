// src/onboarding/schema.ts
import { z } from 'zod'
import { Strictness } from '../config/schema.js'
import { buildStrategyConfig } from './build.js'
import type { OnboardingAnswers } from './types.js'

export const OnboardingAnswersSchema = z.object({
  datanets: z.array(z.object({
    id: z.string(),
    vote: z.boolean(),
    mint: z.boolean(),
    strictness: Strictness,
    adapter: z.string().optional(),
    adapterParams: z.object({
      focus: z.string(),
      angle: z.string(),
      topN: z.number().int().positive(),
      minImportance: z.number().int().min(1).max(10),
    }).partial().optional(),
  })),
  lockReppo: z.number().nonnegative(),
  lockDurationDays: z.number().int().positive(),
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
