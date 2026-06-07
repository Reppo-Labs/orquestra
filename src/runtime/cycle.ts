// src/runtime/cycle.ts
import { STRICTNESS_THRESHOLDS, type StrategyConfig } from '../config/schema.js'
import type { DatanetRubric } from '../rubric/types.js'
import type { DatanetAdapter, CandidateScorer } from '../adapter/types.js'
import type { PodScorer, VoterPod, VoteFilter } from '../voter/types.js'
import type { WalletExecutor } from '../wallet/executor.js'
import type { BudgetLedger } from '../wallet/ledger.js'
import type { ExecResult } from '../wallet/intents.js'
import type { ClaimableEmission } from '../reppo/queryEmissionsDue.js'
import type { ActivityEntry } from '../dashboard/activityLog.js'
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
  getEmissionsDue(): Promise<ClaimableEmission[]>
  /** Claimed (podId:epoch) keys — global, not datanet-scoped (claims are keyed
   *  on-chain by pod+epoch only). */
  seenClaims(): Promise<Set<string>>
  recordActivity(entry: ActivityEntry): void
  recordClaim(key: string): void
}

export interface DatanetReport {
  datanetId: string
  votes: ExecResult[]
  mints: ExecResult[]
  /** set when this datanet was skipped due to an error (rubric unavailable, RPC failure, …). */
  error?: string
}
export interface CycleReport {
  datanets: DatanetReport[]
  /** global emissions-claim results (one query across all our pods, not per-datanet). */
  claims: ExecResult[]
}

/** One swarm cycle: for each configured datanet, vote (if enabled + capable) and
 *  mint (if enabled + adapter + capable). The executor enforces the budget. */
export async function runCycle(config: StrategyConfig, cycleId: string, deps: CycleDeps): Promise<CycleReport> {
  deps.ledger.startCycle(cycleId)
  const datanets: DatanetReport[] = []

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
          // Record dedup ONLY on confirmed execution. A non-executed result (refused,
          // or an 'error' such as a validation failure / missing credential) most often
          // means the tx never submitted — recording it would PERMANENTLY block a
          // legitimate retry. The idempotency key (vote-<pod>-<dir>) guards the rare
          // landed-but-unconfirmed case on retry, and the chain rejects a duplicate vote.
          if (r.status === 'executed') deps.recordVote(datanetId, intent.podId)
          deps.recordActivity({
            ts: new Date().toISOString(), cycleId, kind: 'vote', datanetId,
            podId: intent.podId, direction: intent.direction, conviction: intent.conviction, reason: intent.reason,
            status: r.status, txHash: r.txHash, gasEth: r.gasEth, detail: r.detail,
          })
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
          // Surface the otherwise-silent case where the adapter found candidates but
          // none cleared scoring/dedup — the difference between "no data" and "data
          // rejected" is invisible without this (it hid a zero-mint bug for weeks).
          if (candidates.length > 0 && intents.length === 0) {
            console.error(`orquestra: datanet ${datanetId} — ${candidates.length} mint candidate(s) discovered but none passed scoring/dedup (min score ${minScore}); nothing minted.`)
          }
          for (const intent of intents) {
            const r = await deps.executor.executeMint(intent)
            mints.push(r)
            // Record dedup ONLY on confirmed execution (see vote rationale): a validation
            // or transient error never submitted, so recording it would block a legitimate
            // re-mint. The idempotency key (mint-<canonicalKey>) guards a landed-but-
            // unconfirmed mint on retry. (This recurred live: each missing-credential error
            // poisoned dedup and required manually clearing the key before retrying.)
            if (r.status === 'executed') deps.recordMint(datanetId, intent.canonicalKey)
            deps.recordActivity({
              ts: new Date().toISOString(), cycleId, kind: 'mint', datanetId,
              canonicalKey: intent.canonicalKey, podName: intent.podName,
              status: r.status, txHash: r.txHash, gasEth: r.gasEth, detail: r.detail,
            })
          }
        }
      }

      datanets.push({ datanetId, votes, mints })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error(`orquestra: datanet ${datanetId} skipped — ${error}`)
      datanets.push({ datanetId, votes, mints, error })
    }
  }

  // Global claim phase: emissions-due is one query across ALL our pods (not per
  // datanet). Claim every unclaimed (pod, epoch) we haven't already claimed.
  const claims: ExecResult[] = []
  if (config.claimEmissions) {
    let due: ClaimableEmission[] = []
    try {
      due = await deps.getEmissionsDue()
    } catch (e) {
      console.error(`orquestra: emissions-due query failed, claim phase skipped this cycle — ${e instanceof Error ? e.message : String(e)}`)
    }
    const seen = await deps.seenClaims()
    for (const em of due) {
      const key = `${em.podId}:${em.epoch}`
      if (seen.has(key)) continue
      // Per-claim isolation: one failing claim never aborts the rest of the phase.
      let r: ExecResult
      try {
        r = await deps.executor.executeClaim({ kind: 'claim', datanetId: em.datanetId, podId: em.podId, epoch: em.epoch, reppoDue: em.reppo, idempotencyKey: `claim-${em.podId}-${em.epoch}` })
      } catch (e) {
        r = { ok: false, status: 'error', detail: e instanceof Error ? e.message : String(e) }
      }
      claims.push(r)
      deps.recordActivity({
        ts: new Date().toISOString(), cycleId, kind: 'claim', datanetId: em.datanetId,
        podId: em.podId, epoch: em.epoch, reppoClaimed: em.reppo,
        status: r.status, txHash: r.txHash, gasEth: r.gasEth, detail: r.detail,
      })
      // Record dedup ONLY on confirmed execution: a transiently-failed claim SHOULD retry
      // next cycle — unclaimed emissions are money left on the table, and the chain
      // rejects an already-claimed (pod,epoch). Mark in-memory `seen` too so a duplicate
      // (pod,epoch) in the same `due` list isn't re-claimed this cycle.
      if (r.status === 'executed') { deps.recordClaim(key); seen.add(key) }
    }
  }

  return { datanets, claims }
}
