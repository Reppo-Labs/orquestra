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
    // (3 vs 1 == 75%/25%). Default 1 = equal share. A positive INTEGER: weights are whole
    // numbers (the dashboard input is integer too), and .int() also rejects Infinity/NaN that
    // would collapse the apportionment. Decides distribution within the per-cycle cap; never
    // raises it.
    voteShare: z.number().int().positive().default(1),
  })
  .strict()

export const StrategyConfigSchema = z
  .object({
    horizonDays: z.number().int().positive(),
    // Fractional hours allowed (0.5 = 30 min). Floor of 0.1h (6 min) keeps a typo'd
    // 0.001 from hammering the LLM/chain with a cycle every few seconds.
    cadenceHours: z.number().min(0.1),
    // Ceilings on every spend-limiting field: budget caps are the node's REAL security
    // boundary (the wallet key sits in plaintext .env — the ledger refusing to sign past
    // a cap is the only thing bounding loss), so a single malicious or corrupt config
    // write must not be able to raise them arbitrarily. The values are deliberately
    // generous multiples of any sane strategy (not tuning knobs): 10M REPPO locked /
    // 1M REPPO mint spend dwarf real node budgets, 1k actions/cycle dwarfs real cadence
    // throughput, and 10 ETH of gas is orders beyond Base reality. Legitimate operators
    // never hit them; an attacker who can write config once cannot unbound the wallet.
    stake: z.object({
      lockReppo: z.number().nonnegative().max(10_000_000),
      lockDurationDays: z.number().int().positive(),
    }),
    budget: z.object({
      voteRateMaxPerCycle: z.number().int().nonnegative().max(1_000),
      // Vote-power spend horizon: pace the epoch's voting power over at most this many
      // hours instead of the whole remaining epoch. Reppo resolves vote weight with a
      // linear intra-epoch decay, so an operator who wants to FRONT-LOAD weight (spend
      // most power early, when it resolves highest) sets a short horizon (e.g. 4);
      // absent ⇒ pace evenly across the full remaining epoch (the conservative default —
      // never runs dry before late pods appear). Floor matches cadenceHours' 0.1h.
      voteSpendHorizonHours: z.number().min(0.1).max(1_000).optional(),
      mintRateMaxPerCycle: z.number().int().nonnegative().max(1_000).optional(),
      mintReppoMax: z.number().nonnegative().max(1_000_000),
      // Gas caps are no longer operator-configured — gas on Base is negligible. They
      // default to a high value that never bites in practice but still bounds a
      // runaway loop, and the ledger keeps enforcing them as a safety backstop.
      voteGasEthMax: z.number().nonnegative().max(10).default(1),
      mintGasEthMax: z.number().nonnegative().max(10).default(1),
      claimGasEthMax: z.number().nonnegative().max(10).default(1),
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
    // Platform display name for the node's agent, chosen at onboarding. Used at FIRST
    // registration only (env REPPO_AGENT_NAME wins; later renames via dashboard/env —
    // this field never re-syncs, so it can't clobber a dashboard rename on restart).
    nodeName: z.string().trim().max(64).optional(),
  })
  .transform((cfg) => ({
    ...cfg,
    datanets: { '*': { vote: false, mint: false, strictness: 'balanced' as const, mintMode: 'pin' as const, voteShare: 1 }, ...cfg.datanets } as Record<string, z.infer<typeof DatanetPolicy>>,
  }))

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>
