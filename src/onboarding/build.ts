// src/onboarding/build.ts
import { StrategyConfigSchema, type StrategyConfig } from '../config/schema.js'
import type { OnboardingAnswers } from './types.js'

/** Assemble interview answers into a validated StrategyConfig (throws if invalid). */
export function buildStrategyConfig(a: OnboardingAnswers): StrategyConfig {
  const datanets: Record<string, unknown> = {}
  for (const d of a.datanets) {
    datanets[d.id] = {
      vote: d.vote, mint: d.mint, strictness: d.strictness,
      ...(d.adapter ? { adapter: d.adapter } : {}),
      ...(d.adapterParams ? { adapterParams: d.adapterParams } : {}),
    }
  }
  return StrategyConfigSchema.parse({
    horizonDays: a.horizonDays,
    cadenceHours: a.cadenceHours,
    stake: { lockReppo: a.lockReppo, lockDurationDays: a.lockDurationDays },
    // Gas caps are not operator-configured; StrategyConfigSchema fills high defaults.
    budget: {
      voteRateMaxPerCycle: a.voteRateMaxPerCycle,
      mintReppoMax: a.mintReppoMax,
    },
    claimEmissions: true,
    datanets,
    notes: a.notes,
  })
}
