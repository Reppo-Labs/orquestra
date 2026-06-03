// src/runtime/cycle.ts
import { STRICTNESS_THRESHOLDS, type StrategyConfig } from '../config/schema.js'
import type { DatanetRubric } from '../rubric/types.js'
import type { DatanetAdapter, CandidateScorer } from '../adapter/types.js'
import type { PodScorer, VoterPod, VoteFilter } from '../voter/types.js'
import type { WalletExecutor } from '../wallet/executor.js'
import type { BudgetLedger } from '../wallet/ledger.js'
import type { ExecResult } from '../wallet/intents.js'
import { selectVotes } from '../voter/select.js'
import { selectMints } from '../minter/select.js'

export interface CycleDeps {
  dataDir: string
  topN: number
  getRubric(datanetId: string): Promise<DatanetRubric>
  getPodsAndFilter(datanetId: string): Promise<{ pods: VoterPod[]; filter: VoteFilter }>
  getAdapter(adapterId: string): DatanetAdapter | undefined
  voteScorer: PodScorer
  candidateScorer: CandidateScorer
  seenKeysFor(datanetId: string): Promise<Set<string>>
  executor: WalletExecutor
  ledger: BudgetLedger
  recordVote(datanetId: string, podId: string): void
  recordMint(datanetId: string, canonicalKey: string): void
}

export interface DatanetReport {
  datanetId: string
  votes: ExecResult[]
  mints: ExecResult[]
  /** set when this datanet was skipped due to an error (rubric unavailable, RPC failure, …). */
  error?: string
}
export type CycleReport = DatanetReport[]

/** One swarm cycle: for each configured datanet, vote (if enabled + capable) and
 *  mint (if enabled + adapter + capable). The executor enforces the budget. */
export async function runCycle(config: StrategyConfig, cycleId: string, deps: CycleDeps): Promise<CycleReport> {
  deps.ledger.startCycle(cycleId)
  const report: CycleReport = []

  for (const [datanetId, policy] of Object.entries(config.datanets)) {
    if (datanetId === '*') continue
    if (!policy.vote && !policy.mint) continue
    const votes: ExecResult[] = []
    const mints: ExecResult[] = []

    // Per-datanet isolation: a failure here (RPC error, rubric unavailable on an
    // older reppo CLI, a flaky adapter) skips THIS datanet and is recorded — it
    // never aborts the whole cycle or the other datanets.
    try {
      const rubric = await deps.getRubric(datanetId)

      if (policy.vote && rubric.canVote) {
        const { pods, filter } = await deps.getPodsAndFilter(datanetId)
        const intents = await selectVotes(datanetId, pods, rubric, policy.strictness, filter, deps.voteScorer)
        for (const intent of intents) {
          const r = await deps.executor.executeVote(intent)
          votes.push(r)
          if (r.ok) deps.recordVote(datanetId, intent.podId)
        }
      }

      if (policy.mint && policy.adapter && rubric.canMint) {
        const adapter = deps.getAdapter(policy.adapter)
        if (adapter) {
          const candidates = await adapter.discover({ datanetId, rubric, topN: deps.topN })
          const seenKeys = await deps.seenKeysFor(datanetId)
          const minScore = STRICTNESS_THRESHOLDS[policy.strictness].like
          const intents = await selectMints(datanetId, candidates, rubric, {
            dataDir: deps.dataDir, minScore, seenKeys, scorer: deps.candidateScorer,
          })
          for (const intent of intents) {
            const r = await deps.executor.executeMint(intent)
            mints.push(r)
            if (r.ok) deps.recordMint(datanetId, intent.canonicalKey)
          }
        }
      }

      report.push({ datanetId, votes, mints })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error(`orquestra: datanet ${datanetId} skipped — ${error}`)
      report.push({ datanetId, votes, mints, error })
    }
  }
  return report
}
