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
    cadenceHours: z.number().int().positive(),
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
      // 100-200 REPPO each). Default 0 = grants DISABLED (opt-in): the node won't pay
      // grant fees unless the operator sets a budget, so it can't drain REPPO meant for
      // minting. Defaulted so pre-existing configs still load.
      grantReppoMax: z.number().nonnegative().default(0),
    }),
    claimEmissions: z.boolean().default(true),
    datanets: z.record(z.string(), DatanetPolicy),
    notes: z.string().default(''),
  })
  .transform((cfg) => ({
    ...cfg,
    datanets: { '*': { vote: false, mint: false, strictness: 'balanced' as const }, ...cfg.datanets } as Record<string, z.infer<typeof DatanetPolicy>>,
  }))

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>
