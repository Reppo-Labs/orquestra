// src/runtime/cycle.ts
import { STRICTNESS_THRESHOLDS, type StrategyConfig } from '../config/schema.js'
import type { DatanetRubric } from '../rubric/types.js'
import type { DatanetAdapter, CandidateScorer } from '../adapter/types.js'
import type { PodScorer, VoterPod, VoteFilter } from '../voter/types.js'
import type { WalletExecutor } from '../wallet/executor.js'
import { MINT_REPPO_FALLBACK } from '../wallet/executor.js'
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
  /** per-datanet operator strategy passed to the adapter (e.g. gdelt focus/angle/brief). */
  strategyFor?(datanetId: string): Record<string, unknown>
  /** existing on-chain pod names for a datanet (novelty dedup backstop). */
  getExistingPodNames?(datanetId: string): Promise<string[]>
  /** subnet UUIDs the wallet already has access to (one-time grant cache). */
  grantedSubnets?(): Promise<Set<string>>
  recordGrant?(subnetId: string): void
  /** evict a stale grant-cache entry (e.g. wallet changed → on-chain access gone). */
  revokeGrant?(subnetId: string): void
}

export interface DatanetReport {
  datanetId: string
  votes: ExecResult[]
  mints: ExecResult[]
  /** set when this datanet was skipped due to an error (rubric unavailable, RPC failure, …). */
  error?: string
  /** set when vote/mint were intentionally skipped (e.g. subnet access not granted). */
  skipped?: string
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

    // Record a structured idle/skip reason so the dashboard health panel and
    // lastSkipReason can explain WHY an enabled datanet produced nothing this cycle.
    // Without this, a structurally-incapable datanet (no on-chain rubric/spec, an
    // unregistered adapter id) looks "quietly fine" — the operator gets zero
    // votes/mints with no signal. Fires at most once per reason per datanet per cycle.
    // `activity:false` logs the reason to stderr but does NOT write a skip activity
    // entry — used for mint-incapability reasons on a datanet that ALSO voted this
    // cycle. buildHealth derives idle/lastSkipReason from the newest entry per datanet
    // (src/dashboard/health.ts), so a mint-skip written after a successful vote would
    // mislabel an actively-voting datanet as idle. A datanet that produced no activity
    // still records the skip so the dashboard explains why it is idle.
    const recordSkip = (reason: string, opts: { activity?: boolean } = {}): void => {
      console.error(`orquestra: datanet ${datanetId} — ${reason}`)
      if (opts.activity !== false) {
        deps.recordActivity({ ts: new Date().toISOString(), cycleId, kind: 'skip', datanetId, reason, status: 'skipped' })
      }
    }

    // Per-datanet isolation: a failure here (RPC error, rubric unavailable on an
    // older reppo CLI, a flaky adapter) skips THIS datanet and is recorded — it
    // never aborts the whole cycle or the other datanets.
    try {
      const rubric = await deps.getRubric(datanetId)

      // Subnet access is a one-time prerequisite for both voting and minting. Grant it
      // once per subnet (cached) before either. A datanet whose metadata predates the
      // subnet model (empty subnetUuid) can't be granted and is left to proceed/fail
      // naturally.
      // grant-access is keyed by the INTEGER datanet id (the `--datanet <id>` arg), NOT the
      // subnet uuid; subnetUuid presence just signals the datanet uses the access model.
      // Without access every vote/mint reverts on-chain (VOTER_LACKS_SUBNET_ACCESS) — but
      // only AFTER paying for pod fetching and LLM scoring. So a failed/refused grant
      // skips the datanet for this cycle instead of proceeding; it resumes automatically
      // the cycle after a grant succeeds (e.g. operator raises budget.grantReppoMax).
      if ((policy.vote || policy.mint) && rubric.subnetUuid && deps.grantedSubnets && deps.recordGrant) {
        const granted = await deps.grantedSubnets()
        if (!granted.has(datanetId)) {
          const gr = await deps.executor.executeGrantAccess(datanetId)
          if (gr.status === 'executed') {
            deps.recordGrant(datanetId)
            console.error(`orquestra: datanet ${datanetId} — granted access`)
          } else {
            const skipped = `subnet access not granted (grant-access ${gr.status}: ${gr.detail ?? ''})`
            console.error(`orquestra: datanet ${datanetId} skipped — ${skipped}`)
            deps.recordActivity({
              ts: new Date().toISOString(), cycleId, kind: 'skip', datanetId,
              reason: skipped, status: 'skipped',
            })
            datanets.push({ datanetId, votes, mints, skipped })
            continue
          }
        }
      }

      if (policy.vote && !rubric.canVote) {
        recordSkip('vote enabled but this datanet has no on-chain voter rubric (onboardingVoters) — voting not possible')
      }
      // Pre-scoring budget gate: per-cycle vote rate/gas is shared across datanets, so
      // once it's exhausted (e.g. by an earlier datanet this cycle) scoring more pods is
      // pure wasted LLM spend — every vote would be refused. Skip the scoring entirely.
      if (policy.vote && rubric.canVote && !deps.ledger.canVote()) {
        // Skip the scoring (saves LLM spend) but keep the dashboard breadcrumb: before
        // this gate, refused votes surfaced as refused-budget activity → health. Record a
        // skip so an otherwise-idle datanet still explains why it produced nothing.
        recordSkip('per-cycle vote budget/rate exhausted — skipping vote scoring', { activity: votes.length === 0 })
      } else if (policy.vote && rubric.canVote) {
        const { pods, filter } = await deps.getPodsAndFilter(datanetId)
        const intents = await selectVotes(datanetId, pods, rubric, policy.strictness, filter, deps.voteScorer)
        for (let i = 0; i < intents.length; i++) {
          const intent = intents[i]
          const r = await deps.executor.executeVote(intent)
          votes.push(r)
          // The vote rate/budget cap is monotonic within a cycle: once one vote
          // is refused for budget, every remaining vote this cycle will be too.
          // Stop here and log a SINGLE deferral note rather than one
          // refused-budget row per deferred pod. Those pods are retried next
          // cycle (we only record dedup on 'executed'), so per-pod refused rows
          // otherwise pile up across cycles and read as duplicate votes.
          if (r.status === 'refused-budget') {
            const deferred = intents.length - i
            deps.recordActivity({
              ts: new Date().toISOString(), cycleId, kind: 'skip', datanetId,
              reason: `vote rate/budget cap reached — ${deferred} vote${deferred === 1 ? '' : 's'} deferred to next cycle`,
              status: 'skipped',
            })
            break
          }
          // Record dedup ONLY on confirmed execution. A non-executed result (refused,
          // or an 'error' such as a validation failure / missing credential) most often
          // means the tx never submitted — recording it would PERMANENTLY block a
          // legitimate retry. The idempotency key (vote-<pod>-<dir>) guards the rare
          // landed-but-unconfirmed case on retry, and the chain rejects a duplicate vote.
          // Exception: CANNOT_VOTE_FOR_OWN_POD is PERMANENT (we minted the pod; the
          // own-pods query missed it) — retrying burns a vote attempt every cycle
          // forever, so record it as voted. (Observed live: pod 925 on datanet 9.)
          if (r.status === 'executed') deps.recordVote(datanetId, intent.podId)
          else if (r.status === 'error' && /CANNOT_VOTE_FOR_OWN_POD/.test(r.detail ?? '')) {
            console.error(`orquestra: datanet ${datanetId} pod ${intent.podId} is our own pod — recording as voted so it is not retried`)
            deps.recordVote(datanetId, intent.podId)
          }
          // A VOTER_LACKS_SUBNET_ACCESS error while the grant cache says granted means
          // the cache is STALE (wallet changed, datanet access model changed). Evict so
          // the next cycle re-attempts the grant instead of failing forever.
          if (r.status === 'error' && /VOTER_LACKS_SUBNET_ACCESS/.test(r.detail ?? '')) {
            deps.revokeGrant?.(datanetId)
          }
          deps.recordActivity({
            ts: new Date().toISOString(), cycleId, kind: 'vote', datanetId,
            podId: intent.podId, direction: intent.direction, conviction: intent.conviction, reason: intent.reason,
            status: r.status, txHash: r.txHash, gasEth: r.gasEth, detail: r.detail,
            ...(intent.podName ? { podName: intent.podName } : {}),
            ...(intent.panel ? { panel: intent.panel } : {}),
          })
        }
      }

      // Only surface mint-incapability as a dashboard skip entry when the datanet is
      // otherwise idle this cycle (no votes) — see recordSkip's note on health idle.
      const idleThisCycle = votes.length === 0
      if (policy.mint && !policy.adapter) {
        recordSkip('mint enabled but no adapter is configured for this datanet — minting not possible', { activity: idleThisCycle })
      } else if (policy.mint && policy.adapter && !rubric.canMint) {
        recordSkip('mint enabled but this datanet has no on-chain publisher spec (onboardingPublishers) — minting not possible', { activity: idleThisCycle })
      } else if (policy.mint && policy.adapter && rubric.canMint) {
        const adapter = deps.getAdapter(policy.adapter)
        if (!adapter) {
          recordSkip(`mint enabled but adapter "${policy.adapter}" is not registered on this node`, { activity: idleThisCycle })
        } else if (!deps.ledger.canMint(MINT_REPPO_FALLBACK)) {
          // Mint budget can't fit even one conservative reserve (executeMint reserves
          // MINT_REPPO_FALLBACK pre-sign) — discovering + LLM-scoring candidates that
          // would all be refused is wasted spend. Use the fallback, not 0: canMint(0)
          // would pass with 1-199 REPPO of headroom and then every mint still refuses.
          // Record a skip when otherwise idle so the dashboard still explains the silence.
          recordSkip('mint budget below one mint reserve — skipping mint discovery', { activity: idleThisCycle })
        } else {
          const candidates = await adapter.discover({
            datanetId, rubric, topN: deps.topN,
            strategy: deps.strategyFor?.(datanetId),
            existingPodNames: (await deps.getExistingPodNames?.(datanetId)) ?? [],
          })
          const seenKeys = await deps.seenKeysFor(datanetId)
          const minScore = STRICTNESS_THRESHOLDS[policy.strictness].like
          const intents = await selectMints(datanetId, candidates, rubric, {
            dataDir: deps.dataDir, minScore, seenKeys, scorer: deps.candidateScorer,
            mintMode: policy.mintMode,
          })
          // Surface the otherwise-silent case where the adapter found candidates but
          // none cleared scoring/dedup — the difference between "no data" and "data
          // rejected" is invisible without this (it hid a zero-mint bug for weeks).
          if (candidates.length > 0 && intents.length === 0) {
            recordSkip(`${candidates.length} mint candidate(s) discovered but none passed scoring/dedup (min score ${minScore}); nothing minted`, { activity: idleThisCycle })
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
              // conviction+reason mirror the vote entry so the dashboard shows the
              // mint's score and rationale in Detail (not the canonical-key hash).
              ...(intent.selfScore !== undefined ? { conviction: intent.selfScore } : {}),
              ...(intent.reason ? { reason: intent.reason } : {}),
              status: r.status, txHash: r.txHash, gasEth: r.gasEth, detail: r.detail,
              ...(intent.panel ? { panel: intent.panel } : {}),
            })
          }
        }
      }

      datanets.push({ datanetId, votes, mints })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error(`orquestra: datanet ${datanetId} skipped — ${error}`)
      // Record the failure as a skip activity entry too: without it the dashboard's
      // health/idle panels can't tell "erroring every cycle" from "quietly fine".
      deps.recordActivity({
        ts: new Date().toISOString(), cycleId, kind: 'skip', datanetId,
        reason: `datanet error: ${error}`, status: 'skipped',
      })
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
