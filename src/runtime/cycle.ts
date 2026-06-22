// src/runtime/cycle.ts
import { STRICTNESS_THRESHOLDS, type StrategyConfig } from '../config/schema.js'
import type { DatanetRubric } from '../rubric/types.js'
import type { DatanetAdapter, CandidateScorer } from '../adapter/types.js'
import type { PodScorer, VoterPod, VoteFilter } from '../voter/types.js'
import type { WalletExecutor } from '../wallet/executor.js'
import { MINT_REPPO_FALLBACK } from '../wallet/executor.js'
import type { BudgetLedger } from '../wallet/ledger.js'
import type { ExecResult, VoteIntent } from '../wallet/intents.js'
import type { ClaimableEmission } from '../reppo/queryEmissionsDue.js'
import type { ActivityEntry } from '../dashboard/activityLog.js'
import { redactSecrets } from '../util/redact.js'
import { selectVotes } from '../voter/select.js'
import { allocateVoteSlots } from '../voter/allocate.js'
import { selectMints } from '../minter/select.js'
import { planStakeTopUp, stakeTopUpKey, wasStakeTargetAttempted, markStakeTargetAttempted } from '../wallet/stakeTopUp.js'

/** Top up the wallet's veREPPO toward config.stake.lockReppo at the START of a cycle, on the
 *  HOT-RELOADED config — no restart needed. Locks the difference (an additional lockup) when
 *  the target exceeds current veREPPO, at most once per target (the SHARED per-process latch +
 *  the target-based idempotency key both guard against re-lock spam; the latch is shared with
 *  setupNode, which seeds it after its own startup attempt so cycle-1 doesn't re-attempt the same
 *  target). Wallet-global: the breadcrumb carries no datanetId (empty). Fail-closed: a top-up
 *  failure is logged + recorded but NEVER aborts the cycle — the node keeps voting/minting on its
 *  existing veREPPO. */
async function maybeTopUpStake(config: StrategyConfig, cycleId: string, deps: CycleDeps): Promise<void> {
  try {
    const current = await deps.getVeReppo()
    if (current === null) {
      // A failed balance read is NOT zero — treating it as 0 would lock the FULL target on
      // top of whatever the wallet already holds (over-lock). Skip; retry next cycle.
      console.error('orquestra: veREPPO read failed — skipping stake top-up this cycle')
      return
    }
    const plan = planStakeTopUp(current, config.stake)
    if (!plan) return
    if (wasStakeTargetAttempted(config.stake.lockReppo)) return // already locked this target
    const r = await deps.executor.lock({
      amountReppo: plan.lockAmount,
      durationSeconds: plan.durationSeconds,
      idempotencyKey: stakeTopUpKey(config.stake),
    })
    // Latch ONLY on a confirmed lock. A FAILED lock (insufficient REPPO/gas, RPC blip) must stay
    // retryable — latching it off left the node with zero veREPPO and no on-screen reason until a
    // manual restart (the operator's "I confirmed the lock but it never locked" report). The
    // idempotency key is stable per target, so a retry that re-locks the same amount is safe.
    if (r.status === 'executed') markStakeTargetAttempted(config.stake.lockReppo)
    deps.recordActivity({
      ts: new Date().toISOString(), cycleId, kind: 'stake', datanetId: '',
      // On failure carry the CLI detail (e.g. INSUFFICIENT_REPPO_BALANCE) so the dashboard
      // explains WHY veREPPO is still zero instead of mislabeling the row as "topped up".
      reason: r.status === 'executed'
        ? `topped up veREPPO ${current} → ${config.stake.lockReppo} (+${plan.lockAmount}, ${config.stake.lockDurationDays}d)`
        : `veREPPO lock failed (${r.status}) — wanted +${plan.lockAmount} to reach ${config.stake.lockReppo}${r.detail ? ` — ${r.detail}` : ''}`,
      status: r.status === 'executed' ? 'executed' : 'skipped',
      ...(r.txHash ? { txHash: r.txHash } : {}),
    })
  } catch (e) {
    // Never abort the cycle on a stake top-up failure; the node runs on existing veREPPO.
    console.error(`orquestra: veREPPO top-up failed — ${e instanceof Error ? e.message : String(e)}`)
    deps.recordActivity({
      ts: new Date().toISOString(), cycleId, kind: 'stake', datanetId: '',
      reason: `veREPPO top-up failed — ${e instanceof Error ? e.message : String(e)}`, status: 'skipped',
    })
  }
}

export interface CycleDeps {
  dataDir: string
  topN: number
  getRubric(datanetId: string): Promise<DatanetRubric>
  getPodsAndFilter(datanetId: string): Promise<{ pods: VoterPod[]; filter: VoteFilter }>
  /** Reset the per-CYCLE video-pod budget. Called once at the start of each runCycle so the
   *  `videoPodsPerCycle` cap is global across datanets, not re-armed per datanet. Optional:
   *  tests/wirings without video support omit it. */
  resetVideoBudget?(): void
  getAdapter(adapterId: string): DatanetAdapter | undefined
  /** Per-datanet vote scorer factory. Returns the scorer to use for THIS datanet, or a
   *  skip reason (e.g. no API key for the datanet's chosen provider) — the cycle records
   *  the skip and casts no votes for the datanet, reusing the per-datanet skip mechanism.
   *  Resolved per datanet so each can run on its own provider/model (wiring.ts). */
  voteScorerFor(datanetId: string): { scorer: PodScorer } | { skip: string }
  candidateScorer: CandidateScorer
  seenKeysFor(datanetId: string): Promise<Set<string>>
  /** Live veREPPO balance (for stake top-up). null on a failed read — the caller SKIPS the
   *  top-up rather than coercing to 0 (which would over-lock the full target). */
  getVeReppo(): Promise<number | null>
  executor: WalletExecutor
  ledger: BudgetLedger
  recordVote(datanetId: string, podId: string): void
  recordMint(datanetId: string, canonicalKey: string): void
  getEmissionsDue(): Promise<ClaimableEmission[]>
  /** Claimable VOTER emissions (pods the wallet voted on, not owned). Optional: wirings
   *  without RPC omit it. Claimed via executor.executeVoterClaim. */
  getVoterEmissionsDue?(): Promise<ClaimableEmission[]>
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
  /** Whether the reppo CLI on PATH can pay a NON-REPPO access fee (`grant-access
   *  --token primary`, reppo >=0.8.5). Computed ONCE at startup from the CLI version
   *  (src/reppo/capabilities.ts) and threaded in via wiring. When false, a datanet that
   *  charges a non-REPPO access fee is skipped with a recorded reason rather than firing
   *  an unsupported flag. Defaults to false (fail-closed) when omitted. */
  supportsNonReppoGrants?: boolean
  /** Read the wallet's RAW (un-scaled) balance of an ERC20 token. Injected for testability
   *  and wired in production from the configured RPC URL + wallet address (src/reppo/
   *  tokenBalance.ts). Used to pre-check a NON-REPPO access fee against the wallet balance
   *  BEFORE attempting a grant the CLI would otherwise reject after spending gas. When
   *  ABSENT (no RPC configured), the balance pre-check is skipped and the grant is attempted
   *  anyway — the CLI still fails closed on an underfunded wallet. Only the clean
   *  per-datanet skip-with-reason is lost, not the safety. */
  readTokenBalance?(token: string, owner: string): Promise<bigint>
  /** This node's wallet address — the `owner` passed to readTokenBalance for the balance
   *  pre-check. Omitted (with readTokenBalance) when no RPC/wallet is configured. */
  walletAddress?: string
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
  // Live veREPPO top-up FIRST (on the hot-reloaded config), before any datanet work. Never
  // aborts the cycle — fail-closed inside maybeTopUpStake.
  await maybeTopUpStake(config, cycleId, deps)
  deps.ledger.startCycle(cycleId)
  // Arm the per-cycle video-pod budget once (global across datanets, not per-datanet).
  deps.resetVideoBudget?.()
  const datanets: DatanetReport[] = []

  // Per-datanet vote-slot allocation: split the per-cycle vote cap across vote-enabled
  // datanets by voteShare (largest-remainder; the '*' wildcard is excluded). Each datanet
  // casts up to its slot count in the main loop (Pass 1); a post-loop pass redistributes the
  // unused global budget to datanets that had more eligible pods than their share (Pass 2).
  const voteWeights = new Map<string, number>()
  for (const [id, p] of Object.entries(config.datanets)) {
    if (id !== '*' && p.vote) voteWeights.set(id, p.voteShare)
  }
  const voteSlots = allocateVoteSlots(voteWeights, config.budget.voteRateMaxPerCycle)
  const leftoverIntents = new Map<string, VoteIntent[]>() // scored-but-unvoted, per datanet
  const voteSinks = new Map<string, ExecResult[]>()        // each datanet's `votes` array (same ref the report holds)

  // Cast one vote intent: execute, then record dedup / own-pod / stale-grant eviction + the
  // activity row — EXCEPT on refused-budget, where the per-pod row is suppressed and the
  // caller emits a single deferral breadcrumb instead. Shared by Pass 1 and the Pass 2
  // redistribution so both keep identical dedup/activity semantics.
  const castVote = async (datanetId: string, intent: VoteIntent, sink: ExecResult[]): Promise<ExecResult> => {
    const r = await deps.executor.executeVote(intent)
    sink.push(r)
    if (r.status === 'refused-budget') return r
    // Record dedup ONLY on confirmed execution (a non-executed result most often never
    // submitted, so recording it would permanently block a legitimate retry). Exception:
    // CANNOT_VOTE_FOR_OWN_POD is PERMANENT (we minted the pod; the own-pods query missed it).
    if (r.status === 'executed') deps.recordVote(datanetId, intent.podId)
    else if (r.status === 'error' && /CANNOT_VOTE_FOR_OWN_POD/.test(r.detail ?? '')) {
      console.error(`orquestra: datanet ${datanetId} pod ${intent.podId} is our own pod — recording as voted so it is not retried`)
      deps.recordVote(datanetId, intent.podId)
    }
    // A VOTER_LACKS_SUBNET_ACCESS error while the cache says granted means the cache is STALE —
    // evict so the next cycle re-attempts the grant instead of failing forever.
    if (r.status === 'error' && /VOTER_LACKS_SUBNET_ACCESS/.test(r.detail ?? '')) deps.revokeGrant?.(datanetId)
    deps.recordActivity({
      ts: new Date().toISOString(), cycleId, kind: 'vote', datanetId,
      podId: intent.podId, direction: intent.direction, conviction: intent.conviction, reason: intent.reason,
      status: r.status, txHash: r.txHash, gasEth: r.gasEth, detail: r.detail,
      ...(intent.podName ? { podName: intent.podName } : {}),
      ...(intent.panel ? { panel: intent.panel } : {}),
    })
    return r
  }

  for (const [datanetId, policy] of Object.entries(config.datanets)) {
    if (datanetId === '*') continue
    if (!policy.vote && !policy.mint) continue
    const votes: ExecResult[] = []
    const mints: ExecResult[] = []
    voteSinks.set(datanetId, votes) // so the Pass 2 redistribution appends to this datanet's report



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
      // the cycle after a grant succeeds (e.g. once the wallet has funds for the fee).
      if ((policy.vote || policy.mint) && rubric.subnetUuid && deps.grantedSubnets && deps.recordGrant) {
        const granted = await deps.grantedSubnets()
        if (!granted.has(datanetId)) {
          // Fee currency comes from the rubric: a non-REPPO access fee (accessFeeToken set)
          // must be paid via `grant-access --token primary`. That CLI flag only exists in
          // reppo >=0.8.5, so gate it on the startup-derived capability flag (fail-closed):
          // an older CLI would error on the unknown flag, so skip the datanet with a clear
          // reason instead — per-datanet isolation, never abort the cycle. REPPO-fee
          // datanets (the common case) take the unchanged 'reppo' path with no gate.
          const feeToken = rubric.economics.accessFeeToken
          if (feeToken && !deps.supportsNonReppoGrants) {
            const skipped = `non-REPPO access fee needs reppo CLI ≥ 0.8.5 (this datanet charges ${feeToken.amount} ${feeToken.symbol} for access)`
            console.error(`orquestra: datanet ${datanetId} skipped — ${skipped}`)
            deps.recordActivity({
              ts: new Date().toISOString(), cycleId, kind: 'skip', datanetId,
              reason: skipped, status: 'skipped',
            })
            datanets.push({ datanetId, votes, mints, skipped })
            continue
          }
          // Non-REPPO fee + a balance reader configured: confirm the wallet holds enough of
          // the primary token BEFORE paying. The CLI also pre-flights this, but it costs gas
          // to reach that revert; checking here lets us record a clean per-datanet skip and
          // resume automatically once the operator funds the wallet (we never acquire the
          // token). RAW-to-RAW: compare the rubric's raw integer amount (amountRaw, straight
          // from the CLI's accessFeePrimaryToken.raw) against the raw on-chain balance — no
          // float scaling, so no precision over-estimate and no decimals=0 defeat.
          // When no reader is wired (no RPC), fall through — the CLI still fails closed.
          if (feeToken && deps.readTokenBalance && deps.walletAddress) {
            const required = BigInt(feeToken.amountRaw)
            let balance: bigint | undefined
            try {
              balance = await deps.readTokenBalance(feeToken.address, deps.walletAddress)
            } catch (e) {
              // A failed balance read is NOT proof of insufficiency — don't skip on it.
              // Fall through to the grant attempt (CLI fails closed); just note the read miss.
              console.error(`orquestra: datanet ${datanetId} — ${feeToken.symbol} balance read failed, proceeding to grant (CLI will pre-flight): ${(e as Error).message}`)
            }
            if (balance !== undefined && balance < required) {
              const skipped = `insufficient ${feeToken.symbol} balance for access fee (need ${feeToken.amount} ${feeToken.symbol}) — fund this node's wallet with ${feeToken.symbol}`
              console.error(`orquestra: datanet ${datanetId} skipped — ${skipped}`)
              deps.recordActivity({
                ts: new Date().toISOString(), cycleId, kind: 'skip', datanetId,
                reason: skipped, status: 'skipped',
              })
              datanets.push({ datanetId, votes, mints, skipped })
              continue
            }
          }
          const gr = await deps.executor.executeGrantAccess(datanetId, feeToken ? 'primary' : 'reppo')
          if (gr.status === 'executed') {
            deps.recordGrant(datanetId)
            // Surface the grant (and the fee paid) as an activity breadcrumb so the
            // dashboard Activity view shows e.g. "Granted access — paid 50 EXY". Prefer the
            // receipt-derived ACTUAL the executor read from the CLI result (gr.feePaid), then
            // the on-chain quote (gr.feeAmount), then the rubric's expected amount; note REPPO
            // for the common path. Label with the CLI's fee-token symbol when present, else the
            // rubric's. 'already granted' (no fee charged) says so.
            const feeQty = gr.feePaid ?? gr.feeAmount
            const feeSym = gr.feeToken?.symbol ?? feeToken?.symbol
            const feePaid = feeQty !== undefined
              ? `paid ${feeQty} ${feeSym ?? ''}`.trimEnd()
              : feeToken
                ? `paid ${feeToken.amount} ${feeToken.symbol}`
                : 'paid in REPPO'
            const reason = gr.detail === 'already granted'
              ? 'granted access (already granted — no fee charged)'
              : `granted access — ${feePaid}`
            console.error(`orquestra: datanet ${datanetId} — ${reason}`)
            // kind:'grant' (NOT 'skip'): a successful grant is setup, not idleness. Logging
            // it as a skip would inflate the skip count and could surface "granted access" as
            // lastSkipReason / mark the datanet idle in buildHealth — see src/dashboard/health.ts.
            deps.recordActivity({
              ts: new Date().toISOString(), cycleId, kind: 'grant', datanetId,
              reason, status: 'executed', txHash: gr.txHash, gasEth: gr.gasEth,
            })
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
        const scorerResult = deps.voteScorerFor(datanetId)
        if ('skip' in scorerResult) {
          // Per-datanet isolation: an unresolvable scoring model (e.g. no API key for the
          // datanet's chosen provider) skips THIS datanet's voting with a recorded reason —
          // never aborts the cycle. Record when otherwise idle so the dashboard explains it.
          recordSkip(`vote skipped — ${scorerResult.skip}`, { activity: votes.length === 0 })
        } else {
        const { pods, filter } = await deps.getPodsAndFilter(datanetId)
        // Per-pod scoring skips (e.g. a video ingest skip thrown from scorePod) surface as
        // dashboard activity here so an idle datanet explains why a pod produced no vote —
        // before this they were swallowed with only a stderr line. The reason is already
        // redacted by selectVotes.
        const intents = await selectVotes(datanetId, pods, rubric, policy.strictness, filter, scorerResult.scorer,
          (podId, reason) => deps.recordActivity({
            ts: new Date().toISOString(), cycleId, kind: 'skip', datanetId,
            podId, reason: `pod scoring skipped — ${reason}`, status: 'skipped',
          }))
        // Pass 1: cast up to this datanet's vote-share slot; stash the rest for the post-loop
        // redistribution. A refused-budget result (global cap hit) leaves the intent pending
        // too; the single deferral breadcrumb is emitted after Pass 2, not per pod.
        const cap = voteSlots.get(datanetId) ?? 0
        let cast = 0
        const pending: VoteIntent[] = []
        for (let i = 0; i < intents.length; i++) {
          // Stop at this datanet's slot share, or once the global cap is exhausted — and on a
          // refusal (monotonic within a cycle). Remaining intents are stashed for Pass 2; a
          // single deferral note is emitted after Pass 2 (not one refused row per pod).
          if (cast >= cap || !deps.ledger.canVote()) { pending.push(...intents.slice(i)); break }
          const r = await castVote(datanetId, intents[i], votes)
          if (r.status === 'refused-budget') { pending.push(...intents.slice(i)); break }
          cast++
        }
        if (pending.length) leftoverIntents.set(datanetId, pending)
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
      console.error(redactSecrets(`orquestra: datanet ${datanetId} skipped — ${error}`))
      // Record the failure as a skip activity entry too: without it the dashboard's
      // health/idle panels can't tell "erroring every cycle" from "quietly fine".
      deps.recordActivity({
        ts: new Date().toISOString(), cycleId, kind: 'skip', datanetId,
        reason: `datanet error: ${error}`, status: 'skipped',
      })
      datanets.push({ datanetId, votes, mints, error })
    }
  }

  // Pass 2 — redistribute the unused global vote budget to datanets that still have scored,
  // unvoted intents, weighted by voteShare. Re-splitting `votesRemaining` each round lets a
  // datanet with fewer leftovers than its allotment hand the surplus to the rest, until the
  // budget is spent or all stashes drain. The ledger remains the hard cap (castVote refuses
  // past it). Votes land in each datanet's own ExecResult array via voteSinks (same ref the
  // report holds), so reports stay accurate.
  if ([...leftoverIntents.values()].some((arr) => arr.length > 0)) {
    while (deps.ledger.canVote()) {
      const pending = [...leftoverIntents].filter(([, arr]) => arr.length > 0)
      if (pending.length === 0) break
      const remaining = deps.ledger.votesRemaining()
      if (remaining <= 0) break
      // Every pending id is vote-enabled, so it is always in voteWeights (set at the top) and
      // voteSinks (set in the loop). A missing entry would be a real bug — skip it rather than
      // invent a weight-1 phantom or cast into a throwaway array that vanishes from the report.
      const split = allocateVoteSlots(new Map(pending.map(([id]) => [id, voteWeights.get(id)!])), remaining)
      let progressed = false
      for (const [id, arr] of pending) {
        const sink = voteSinks.get(id)
        if (!sink) continue
        let n = split.get(id) ?? 0
        while (n > 0 && arr.length > 0 && deps.ledger.canVote()) {
          const r = await castVote(id, arr[0], sink)
          if (r.status === 'refused-budget') break
          arr.shift(); n--; progressed = true
        }
      }
      if (!progressed) break
    }
    // A single deferral breadcrumb per datanet whose pods couldn't all be voted this cycle
    // (retried next cycle — dedup is recorded only on executed).
    for (const [id, arr] of leftoverIntents) {
      if (arr.length > 0) deps.recordActivity({
        ts: new Date().toISOString(), cycleId, kind: 'skip', datanetId: id,
        reason: `vote rate/budget cap reached — ${arr.length} vote${arr.length === 1 ? '' : 's'} deferred to next cycle`,
        status: 'skipped',
      })
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
        // Prefer the actual claimed REPPO read from the tx receipt (em.reppo is 0 under
        // on-chain detection — PodManager V2 has no pre-claim amount view).
        podId: em.podId, epoch: em.epoch, reppoClaimed: r.reppoClaimed ?? em.reppo,
        status: r.status, txHash: r.txHash, gasEth: r.gasEth, detail: r.detail,
      })
      // Record dedup ONLY on confirmed execution: a transiently-failed claim SHOULD retry
      // next cycle — unclaimed emissions are money left on the table, and the chain
      // rejects an already-claimed (pod,epoch). Mark in-memory `seen` too so a duplicate
      // (pod,epoch) in the same `due` list isn't re-claimed this cycle.
      if (r.status === 'executed') { deps.recordClaim(key); seen.add(key) }
    }

    // Voter emissions: a separate on-chain pool the wallet earns for curating OTHERS' pods
    // (claimVoterEmissions). Distinct claim path; dedup keys are prefixed `voter-` so they
    // never collide with owner-claim keys for the same (pod,epoch).
    let voterDue: ClaimableEmission[] = []
    try {
      voterDue = (await deps.getVoterEmissionsDue?.()) ?? []
    } catch (e) {
      console.error(`orquestra: voter emissions-due query failed, voter-claim skipped this cycle — ${e instanceof Error ? e.message : String(e)}`)
    }
    for (const em of voterDue) {
      const key = `voter-${em.podId}:${em.epoch}`
      if (seen.has(key)) continue
      let r: ExecResult
      try {
        r = await deps.executor.executeVoterClaim({ kind: 'claim', datanetId: em.datanetId, podId: em.podId, epoch: em.epoch, reppoDue: em.reppo, idempotencyKey: `claim-voter-${em.podId}-${em.epoch}` })
      } catch (e) {
        r = { ok: false, status: 'error', detail: e instanceof Error ? e.message : String(e) }
      }
      claims.push(r)
      deps.recordActivity({
        ts: new Date().toISOString(), cycleId, kind: 'claim', datanetId: em.datanetId,
        podId: em.podId, epoch: em.epoch, reppoClaimed: r.reppoClaimed ?? em.reppo,
        status: r.status, txHash: r.txHash, gasEth: r.gasEth,
        detail: r.detail ? `voter · ${r.detail}` : 'voter emissions',
      })
      if (r.status === 'executed') { deps.recordClaim(key); seen.add(key) }
    }
  }

  return { datanets, claims }
}
