// src/config/schema.ts
import { z } from 'zod'

export const STRICTNESS_THRESHOLDS = {
  conservative: { like: 8, dislike: 4 },
  balanced: { like: 7, dislike: 3 },
  aggressive: { like: 6, dislike: 2 },
} as const

export const Strictness = z.enum(['conservative', 'balanced', 'aggressive'])
/** The strictness union as a TS type (stable; prefer over zod-internal `._type`). */
export type StrictnessLevel = z.infer<typeof Strictness>

const DatanetPolicy = z
  .object({
    vote: z.boolean().default(false),
    mint: z.boolean().default(false),
    strictness: Strictness.default('balanced'),
    adapter: z.string().optional(),
    adapterParams: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export const StrategyConfigSchema = z
  .object({
    horizonDays: z.number().int().positive(),
    // Fractional hours allowed (0.5 = 30 min). Floor of 0.1h (6 min) keeps a typo'd
    // 0.001 from hammering the LLM/chain with a cycle every few seconds.
    cadenceHours: z.number().min(0.1),
    stake: z.object({
      lockReppo: z.number().nonnegative(),
      lockDurationDays: z.number().int().positive(),
    }),
    budget: z.object({
      voteGasEthMax: z.number().nonnegative(),
      voteRateMaxPerCycle: z.number().int().nonnegative(),
      mintReppoMax: z.number().nonnegative(),
      mintGasEthMax: z.number().nonnegative(),
      // Defaulted (not required) so configs written before this cap existed still load.
      claimGasEthMax: z.number().nonnegative().default(0.05),
      // Cumulative REPPO the node may spend on one-time subnet-access grants (fee is
      // 100-200 REPPO each). Unset = no cap: enabling a datanet (vote/mint) IS the
      // consent to pay its grant fee, so joined datanets get access automatically.
      // Set a number to bound total grant spend (0 disables grants entirely).
      grantReppoMax: z.number().nonnegative().optional(),
    }),
    claimEmissions: z.boolean().default(true),
    // Multi-agent panel deliberation (see docs/superpowers/specs/2026-06-11-multi-agent-decisions-design.md).
    // Defaulted so configs written before this feature load unchanged.
    deliberation: z
      .object({
        enabled: z.boolean().default(true),
        // ± band around the like/dislike thresholds that convenes a vote panel; 0 = mints only.
        voteBand: z.number().int().min(0).max(4).default(1),
      })
      .default({ enabled: true, voteBand: 1 }),
    datanets: z.record(z.string(), DatanetPolicy),
    notes: z.string().default(''),
  })
  .transform((cfg) => ({
    ...cfg,
    datanets: { '*': { vote: false, mint: false, strictness: 'balanced' as const }, ...cfg.datanets } as Record<string, z.infer<typeof DatanetPolicy>>,
  }))

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>
