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
    }),
    datanets: z.record(z.string(), DatanetPolicy),
    notes: z.string().default(''),
  })
  .transform((cfg) => ({
    ...cfg,
    datanets: { '*': { vote: false, mint: false, strictness: 'balanced' as const }, ...cfg.datanets } as Record<string, z.infer<typeof DatanetPolicy>>,
  }))

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>
