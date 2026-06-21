// src/config/schema.ts
import { z } from 'zod'
import { LlmProviderEnum } from '../llm/model.js'

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
    // How a minted pod's data is attached:
    //   'pin'      → pin the dataset JSON to IPFS (needs PINATA_JWT). Default.
    //   'url-only' → register the candidate's source URL as the pod, no pinning,
    //                no Pinata. Only valid for candidates that have a sourceUrl.
    mintMode: z.enum(['pin', 'url-only']).default('pin'),
    // Per-datanet LLM override for the VOTING scorer. Absent ⇒ the node default
    // (LLM_PROVIDER/LLM_API_KEY). provider must be a known LlmProvider; model is a
    // non-empty slug (validated lazily — an unknown slug fails at request time).
    model: z.object({ provider: LlmProviderEnum, model: z.string().min(1) }).optional(),
    // Relative weight for splitting this cycle's vote slots across vote-enabled datanets
    // (largest-remainder apportionment of budget.voteRateMaxPerCycle). Only ratios matter
    // (3 vs 1 == 75%/25%). Default 1 = equal share. .finite() rejects Infinity/NaN, which
    // would collapse the apportionment. Decides distribution within the per-cycle cap; never
    // raises it.
    voteShare: z.number().positive().finite().default(1),
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
      voteRateMaxPerCycle: z.number().int().nonnegative(),
      mintReppoMax: z.number().nonnegative(),
      // Gas caps are no longer operator-configured — gas on Base is negligible. They
      // default to a high value that never bites in practice but still bounds a
      // runaway loop, and the ledger keeps enforcing them as a safety backstop.
      voteGasEthMax: z.number().nonnegative().default(1),
      mintGasEthMax: z.number().nonnegative().default(1),
      claimGasEthMax: z.number().nonnegative().default(1),
    }),
    claimEmissions: z.boolean().default(true),
    // Multi-agent panel deliberation (personas + judge; see src/panel/).
    // Defaulted so configs written before this feature load unchanged.
    deliberation: z
      .object({
        enabled: z.boolean().default(true),
        // All votes go to the panel when true; false = panel for mints only (votes use
        // the single scorer). Mints always use the panel while `enabled`.
        votePanel: z.boolean().default(true),
      })
      .default({ enabled: true, votePanel: true }),
    datanets: z.record(z.string(), DatanetPolicy),
    // Node default LLM model — the dashboard-selectable fallback used wherever there is
    // no per-datanet `model` override (scoring) and by the Assistant/onboarding chat.
    // Absent ⇒ the env LLM_PROVIDER default. `provider` must be a known LlmProvider.
    defaultModel: z.object({ provider: LlmProviderEnum, model: z.string().min(1) }).optional(),
    notes: z.string().default(''),
  })
  .transform((cfg) => ({
    ...cfg,
    datanets: { '*': { vote: false, mint: false, strictness: 'balanced' as const, mintMode: 'pin' as const, voteShare: 1 }, ...cfg.datanets } as Record<string, z.infer<typeof DatanetPolicy>>,
  }))

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>
