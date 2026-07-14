// src/runtime/cycle.ts
import { STRICTNESS_THRESHOLDS, type StrategyConfig } from '../config/schema.js'
import { toVoteRubric, toMintRubric, type DatanetRubric } from '../rubric/types.js'
import type { DatanetAdapter, CandidateScorer } from '../adapter/types.js'
import type { PodScorer, VoterPod, VoteFilter } from '../voter/types.js'
import type { WalletExecutor } from '../wallet/executor.js'
import { MINT_REPPO_FALLBACK } from '../wallet/executor.js'
import type { BudgetLedger } from '../wallet/ledger.js'
import type { ExecResult, VoteIntent, ClaimIntent } from '../wallet/intents.js'
import type { ClaimableEmission } from '../reppo/reader.js'
import type { ActivityEntry } from '../dashboard/activityLog.js'
import { redactSecrets } from '../util/redact.js'
import { computeYield, formatYieldLine, type DatanetYield } from '../voter/yield.js'
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
    const current = await deps.reads.getVeReppo()
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
    deps.activity.record({
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
    deps.activity.record({
      ts: new Date().toISOString(), cycleId, kind: 'stake', datanetId: '',
      reason: `veREPPO top-up failed — ${e instanceof Error ? e.message : String(e)}`, status: 'skipped',
    })
  }
}

/** Wallet-scoped on-chain reads — the tier of OnchainReads that needs the node's wallet
 *  address on top of an RPC URL. Present-or-absent AS A UNIT: wiring derives the address
 *  once at startup (it can be unknown even with RPC configured, e.g. a failed
 *  `reppo query balance`), and everything here is off together when it is. */
export interface OnchainWalletReads {
  /** This node's wallet address — the `owner` for readTokenBalance's fee pre-check. */
  address: string
  /** Read the wallet's RAW (un-scaled) balance of an ERC20 token (src/reppo/reader.ts).
   *  Used to pre-check a NON-REPPO access fee BEFORE attempting a grant the CLI would
   *  otherwise reject after spending gas. When the wallet tier is absent, the pre-check
   *  is skipped and the grant is attempted anyway — the CLI still fails closed on an
   *  underfunded wallet. Only the clean per-datanet skip-with-reason is lost. */
  readTokenBalance(token: string, owner: string): Promise<bigint>
  /** Claimable VOTER emissions (pods the wallet voted on, not owned). RPC-only — no
   *  platform-API fallback exists. Claimed via executor.executeVoterClaim. */
  getVoterEmissionsDue(): Promise<ClaimableEmission[]>
}

/** RPC-backed reads, present-or-absent AS A UNIT (`onchain?: OnchainReads`): wiring
 *  decides ONCE whether an RPC URL is configured instead of scattering per-field
 *  optionals. Absence ⇒ every on-chain feature quietly degrades exactly as before
 *  (yield unavailable, no voter-claim scan, no fee pre-check). */
export interface OnchainReads {
  /** Σ current-epoch vote weight across the given pods (raw 18-dec) + the epoch read.
   *  A throw ⇒ yield is reported as unavailable — never treated as zero volume, never
   *  aborts the datanet. */
  getEpochVoteVolume(podIds: string[]): Promise<{ epoch: number; totalRaw: bigint }>
  /** Wallet-scoped tier — absent when the wallet address could not be derived. */
  wallet?: OnchainWalletReads
}

/** One-time subnet-access grant cache — a nested unit of Dedup. Absent ⇒ the subnet
 *  gate is not applicable (wirings without grant support); production wiring always
 *  provides it, backed by DedupState's flat grant set. */
export interface GrantCache {
  /** datanet ids the wallet already has subnet access to (see DedupState — the values
   *  are INTEGER datanet ids, the historical field name notwithstanding). */
  granted(): Promise<Set<string>>
  record(datanetId: string): void
  /** evict a stale entry (e.g. wallet changed → on-chain access gone). */
  revoke(datanetId: string): void
}

/** Persistent dedup state — what was already voted/minted/claimed/granted, so the node
 *  never re-signs work the chain would reject (or double-pays for). Backed by DedupState
 *  (SQLite) in production; the cycle records ONLY confirmed executions here. */
export interface Dedup {
  /** minted canonical keys for a datanet (mint dedup). */
  seenKeysFor(datanetId: string): Promise<Set<string>>
  recordVote(datanetId: string, podId: string): void
  recordMint(datanetId: string, canonicalKey: string): void
  /** Claimed (podId:epoch) keys — global, not datanet-scoped (claims are keyed
   *  on-chain by pod+epoch only). */
  seenClaims(): Promise<Set<string>>
  recordClaim(key: string): void
  grants?: GrantCache
}

/** LLM scoring surface. voteScorerFor routes each datanet to its model (per-datanet
 *  `model` override, else the live node default) with a build-once scorer cache keyed
 *  by the RESOLVED provider:model; candidateScorer scores mint candidates on the live
 *  effective default. Built by src/runtime/scorers.ts. */
export interface Scorers {
  /** Returns the scorer for THIS datanet, or a skip reason (e.g. no API key for the
   *  datanet's chosen provider) — the cycle records the skip and casts no votes for
   *  the datanet, reusing the per-datanet skip mechanism. */
  voteScorerFor(datanetId: string): { scorer: PodScorer } | { skip: string }
  candidateScorer: CandidateScorer
}

/** How the cycle tells the world what it did: the activity log rows the dashboard is
 *  built from, plus the per-cycle arming hook and the platform vote registration. */
export interface ActivityStore {
  /** Persist one activity row. Wiring never throws this into the cycle. */
  record(entry: ActivityEntry): void
  /** Arm per-cycle wiring state. Called once at the start of each runCycle so the
   *  `videoPodsPerCycle` budget and the cycle's activity-history snapshot are global
   *  across datanets, not re-armed per datanet. Optional: tests/wirings without that
   *  state omit it. */
  beginCycle?(): void
  /** Register the on-chain vote with the Reppo platform API so the frontend can display
   *  it. Fire-and-forget: absence or failure never aborts the cycle. */
  registerVoteOnPlatform?(podId: string, txHash: string): Promise<void>
}

/** The per-datanet / per-cycle reads runCycle decides from — always available (each has
 *  a CLI path), unlike the RPC-gated OnchainReads. */
export interface CycleReads {
  getRubric(datanetId: string): Promise<DatanetRubric>
  getPodsAndFilter(datanetId: string): Promise<{ pods: VoterPod[]; filter: VoteFilter }>
  /** Live veREPPO balance (for stake top-up). null on a failed read — the caller SKIPS the
   *  top-up rather than coercing to 0 (which would over-lock the full target). */
  getVeReppo(): Promise<number | null>
  /** Claimable OWNER emissions (on-chain detection when RPC+wallet are wired, else the
   *  platform CLI fallback — the choice is wiring's, invisible here). */
  getEmissionsDue(): Promise<ClaimableEmission[]>
}

/** Adapter routing plus the per-datanet inputs the cycle threads into adapter.discover. */
export interface AdapterHub {
  get(adapterId: string): DatanetAdapter | undefined
  /** max candidates an adapter should return per discovery. */
  topN: number
  /** per-datanet operator strategy passed to the adapter (e.g. gdelt focus/angle/brief). */
  strategyFor(datanetId: string): Record<string, unknown>
  /** existing on-chain pod names for a datanet (novelty dedup backstop). */
  existingPodNames(datanetId: string): Promise<string[]>
}

/** Everything runCycle needs, as named collaborators (built by wiring.ts buildCycleDeps).
 *  runCycle is pure policy over these: per-datanet isolation, vote-slot allocation and
 *  redistribution, mint selection, the claim phase. */
export interface CycleDeps {
  dataDir: string
  /** Per-datanet / per-cycle reads. */
  reads: CycleReads
  /** Adapter routing + discover inputs (minting). */
  adapters: AdapterHub
  /** LLM scoring (vote scorer routing + mint candidate scoring). */
  scorers: Scorers
  /** Persistent already-done state (votes/mints/claims/grants). */
  dedup: Dedup
  /** Activity log + per-cycle arming + platform vote registration. */
  activity: ActivityStore
  /** On-chain reads — absent as a unit on an RPC-less node. */
  onchain?: OnchainReads
  executor: WalletExecutor
  ledger: BudgetLedger
  /** Whether the reppo CLI on PATH can pay a NON-REPPO access fee (`grant-access
   *  --token primary`, reppo >=0.8.5). Computed ONCE at startup from the CLI version
   *  (src/reppo/capabilities.ts) and threaded in via wiring. When false, a datanet that
   *  charges a non-REPPO access fee is skipped with a recorded reason rather than firing
   *  an unsupported flag. Defaults to false (fail-closed) when omitted. */
  supportsNonReppoGrants?: boolean
}

/** Persist a structured skip row (kind:'skip') — the one shape every skip path shares.
 *  The dashboard health panel and lastSkipReason are derived from these rows. `podId`
 *  scopes a per-pod scoring skip; absent for datanet-level skips. */
function recordSkipActivity(deps: CycleDeps, cycleId: string, datanetId: string, reason: string, podId?: string): void {
  deps.activity.record({
    ts: new Date().toISOString(), cycleId, kind: 'skip', datanetId,
    ...(podId !== undefined ? { podId } : {}),
    reason, status: 'skipped',
  })
}

type SubnetAccessResult = { status: 'ok' } | { status: 'skipped'; reason: string }

/** Subnet access is a one-time prerequisite for both voting and minting. Grant it once
 *  per subnet (cached) before either. A datanet whose metadata predates the subnet model
 *  (empty subnetUuid) can't be granted and is left to proceed/fail naturally.
 *  grant-access is keyed by the INTEGER datanet id (the `--datanet <id>` arg), NOT the
 *  subnet uuid; subnetUuid presence just signals the datanet uses the access model.
 *  Without access every vote/mint reverts on-chain (VOTER_LACKS_SUBNET_ACCESS) — but
 *  only AFTER paying for pod fetching and LLM scoring. So a failed/refused grant returns
 *  'skipped' (the caller skips the datanet for this cycle instead of proceeding); it
 *  resumes automatically the cycle after a grant succeeds (e.g. once the wallet has
 *  funds for the fee). Skip reasons are recorded here; the caller only threads the
 *  reason into the report. */
async function ensureSubnetAccess(
  datanetId: string,
  policy: { vote: boolean; mint: boolean },
  rubric: DatanetRubric,
  cycleId: string,
  deps: CycleDeps,
): Promise<SubnetAccessResult> {
  const grants = deps.dedup.grants
  if (!(policy.vote || policy.mint) || !rubric.subnetUuid || !grants) {
    return { status: 'ok' } // gate not applicable — proceed
  }
  const granted = await grants.granted()
  if (granted.has(datanetId)) return { status: 'ok' }
  const skip = (reason: string): SubnetAccessResult => {
    console.error(`orquestra: datanet ${datanetId} skipped — ${reason}`)
    recordSkipActivity(deps, cycleId, datanetId, reason)
    return { status: 'skipped', reason }
  }
  // Fee currency comes from the rubric: a non-REPPO access fee (accessFeeToken set)
  // must be paid via `grant-access --token primary`. That CLI flag only exists in
  // reppo >=0.8.5, so gate it on the startup-derived capability flag (fail-closed):
  // an older CLI would error on the unknown flag, so skip the datanet with a clear
  // reason instead — per-datanet isolation, never abort the cycle. REPPO-fee
  // datanets (the common case) take the unchanged 'reppo' path with no gate.
  const feeToken = rubric.economics.accessFeeToken
  if (feeToken && !deps.supportsNonReppoGrants) {
    return skip(`non-REPPO access fee needs reppo CLI ≥ 0.8.5 (this datanet charges ${feeToken.amount} ${feeToken.symbol} for access)`)
  }
  // Non-REPPO fee + a balance reader configured: confirm the wallet holds enough of
  // the primary token BEFORE paying. The CLI also pre-flights this, but it costs gas
  // to reach that revert; checking here lets us record a clean per-datanet skip and
  // resume automatically once the operator funds the wallet (we never acquire the
  // token). RAW-to-RAW: compare the rubric's raw integer amount (amountRaw, straight
  // from the CLI's accessFeePrimaryToken.raw) against the raw on-chain balance — no
  // float scaling, so no precision over-estimate and no decimals=0 defeat.
  // When the wallet tier is not wired (no RPC / no address), fall through — the CLI
  // still fails closed.
  const wallet = deps.onchain?.wallet
  if (feeToken && wallet) {
    const required = BigInt(feeToken.amountRaw)
    let balance: bigint | undefined
    try {
      balance = await wallet.readTokenBalance(feeToken.address, wallet.address)
    } catch (e) {
      // A failed balance read is NOT proof of insufficiency — don't skip on it.
      // Fall through to the grant attempt (CLI fails closed); just note the read miss.
      console.error(`orquestra: datanet ${datanetId} — ${feeToken.symbol} balance read failed, proceeding to grant (CLI will pre-flight): ${(e as Error).message}`)
    }
    if (balance !== undefined && balance < required) {
      return skip(`insufficient ${feeToken.symbol} balance for access fee (need ${feeToken.amount} ${feeToken.symbol}) — fund this node's wallet with ${feeToken.symbol}`)
    }
  }
  const gr = await deps.executor.executeGrantAccess(datanetId, feeToken ? 'primary' : 'reppo')
  if (gr.status !== 'executed') {
    return skip(`subnet access not granted (grant-access ${gr.status}: ${gr.detail ?? ''})`)
  }
  grants.record(datanetId)
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
  deps.activity.record({
    ts: new Date().toISOString(), cycleId, kind: 'grant', datanetId,
    reason, status: 'executed', txHash: gr.txHash, gasEth: gr.gasEth,
  })
  return { status: 'ok' }
}

/** Claim every unclaimed (pod, epoch) in `due`, recording activity + dedup. One loop
 *  serves both claim kinds — OWNER (pods we minted) and VOTER (pods we curated) — which
 *  differ only in the executor method, the dedup/idempotency key prefixes, and the
 *  activity detail label. `seen` is the SHARED claimed-key set: mutated in place so a
 *  duplicate (pod,epoch) in the same list isn't re-claimed this cycle, and so the
 *  caller's post-claim filtering sees exactly what was claimed.
 *  Per-claim isolation: one failing claim never aborts the rest of the phase.
 *  Dedup is recorded ONLY on confirmed execution: a transiently-failed claim SHOULD
 *  retry next cycle — unclaimed emissions are money left on the table, and the chain
 *  rejects an already-claimed (pod,epoch). */
async function claimPhase(
  due: ClaimableEmission[],
  seen: Set<string>,
  cycleId: string,
  deps: CycleDeps,
  opts: {
    /** dedup-key prefix: '' (owner) or 'voter-' — voter keys never collide with owner
     *  keys for the same (pod,epoch). */
    keyPrefix: string
    /** intent idempotencyKey prefix: 'claim-' (owner) or 'claim-voter-'. */
    idempotencyPrefix: string
    execute: (intent: ClaimIntent) => Promise<ExecResult>
    /** activity detail label — owner passes r.detail through; voter prefixes it. */
    detail: (r: ExecResult) => string | undefined
  },
): Promise<ExecResult[]> {
  const results: ExecResult[] = []
  for (const em of due) {
    const key = `${opts.keyPrefix}${em.podId}:${em.epoch}`
    if (seen.has(key)) continue
    let r: ExecResult
    try {
      r = await opts.execute({ kind: 'claim', datanetId: em.datanetId, podId: em.podId, epoch: em.epoch, reppoDue: em.reppo, token: em.token, idempotencyKey: `${opts.idempotencyPrefix}${em.podId}-${em.epoch}` })
    } catch (e) {
      r = { ok: false, status: 'error', detail: e instanceof Error ? e.message : String(e) }
    }
    results.push(r)
    deps.activity.record({
      ts: new Date().toISOString(), cycleId, kind: 'claim', datanetId: em.datanetId,
      // Prefer the actual claimed REPPO read from the tx receipt (em.reppo is 0 under
      // on-chain detection — PodManager V2 has no pre-claim amount view).
      podId: em.podId, epoch: em.epoch, reppoClaimed: r.reppoClaimed ?? em.reppo,
      claimedTokenSymbol: r.tokenClaimed?.symbol, claimedTokenAmount: r.tokenClaimed?.amount,
      status: r.status, txHash: r.txHash, gasEth: r.gasEth, detail: opts.detail(r),
    })
    if (r.status === 'executed') { deps.dedup.recordClaim(key); seen.add(key) }
  }
  return results
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
  /** OWNER (pod,epoch) pairs still claimable AFTER this cycle's claim attempts — the claim
   *  phase's on-chain scan minus what it just claimed. The dashboard snapshot reuses this
   *  instead of re-scanning PodManager a second time per cycle. Empty when claiming is off. */
  emissionsDue: ClaimableEmission[]
  /** Per-datanet emission economics computed this cycle (vote-scoring datanets only).
   *  Fresh each cycle — the dashboard snapshot copies it verbatim, no merge-over-previous. */
  datanetEconomics: DatanetYield[]
}

/** One swarm cycle: for each configured datanet, vote (if enabled + capable) and
 *  mint (if enabled + adapter + capable). The executor enforces the budget. */
export async function runCycle(config: StrategyConfig, cycleId: string, deps: CycleDeps): Promise<CycleReport> {
  // ── PAUSE: the operator's kill switch (config.paused, hot-reloaded each cycle). ──────
  // This is the single chokepoint through which EVERY signing path in the node runs — the
  // stake lock, the subnet grant, votes, mints and claims all originate below this line —
  // so one refusal here means literally nothing is signed while paused. It sits BEFORE
  // maybeTopUpStake (which locks veREPPO) and before ledger.startCycle, and it returns an
  // empty report, so no datanet is even iterated. The scheduler keeps ticking and the
  // dashboard keeps serving; clearing the flag resumes normal behavior on the next cycle
  // with no restart.
  // ADDITIVE, never a replacement: the BudgetLedger still reserves-before-signing and still
  // refuses past its caps on every unpaused cycle. Pausing adds a refusal; it removes none.
  if (config.paused) {
    console.error(`orquestra: cycle ${cycleId} — node is PAUSED; no votes, mints, claims, grants or locks this cycle`)
    // datanetId '' (wallet-global, like the 'stake' breadcrumb) so the row explains the
    // silence in the activity feed without registering a phantom datanet in buildHealth
    // (which skips entries with no datanetId) or flipping a real datanet to idle.
    deps.activity.record({
      ts: new Date().toISOString(), cycleId, kind: 'skip', datanetId: '',
      reason: 'node paused by the operator — no votes, mints, claims, grants or locks this cycle (spending resumes as soon as you unpause)',
      status: 'skipped',
    })
    return { datanets: [], claims: [], emissionsDue: [], datanetEconomics: [] }
  }

  // Live veREPPO top-up FIRST (on the hot-reloaded config), before any datanet work. Never
  // aborts the cycle — fail-closed inside maybeTopUpStake.
  await maybeTopUpStake(config, cycleId, deps)
  deps.ledger.startCycle(cycleId)
  // Arm per-cycle wiring state once (video-pod budget + activity snapshot — global
  // across datanets, not per-datanet).
  deps.activity.beginCycle?.()
  const datanets: DatanetReport[] = []
  const datanetEconomics: DatanetYield[] = []

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
    if (r.status === 'executed') {
      deps.dedup.recordVote(datanetId, intent.podId)
      if (r.txHash) deps.activity.registerVoteOnPlatform?.(intent.podId, r.txHash)
        .catch((e: unknown) => console.error(redactSecrets(`orquestra: platform vote register failed pod ${intent.podId}: ${(e as Error).message}`)))
    } else if (r.status === 'error' && /CANNOT_VOTE_FOR_OWN_POD/.test(r.detail ?? '')) {
      console.error(`orquestra: datanet ${datanetId} pod ${intent.podId} is our own pod — recording as voted so it is not retried`)
      deps.dedup.recordVote(datanetId, intent.podId)
    }
    // A VOTER_LACKS_SUBNET_ACCESS error while the cache says granted means the cache is STALE —
    // evict so the next cycle re-attempts the grant instead of failing forever.
    if (r.status === 'error' && /VOTER_LACKS_SUBNET_ACCESS/.test(r.detail ?? '')) deps.dedup.grants?.revoke(datanetId)
    deps.activity.record({
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
      if (opts.activity !== false) recordSkipActivity(deps, cycleId, datanetId, reason)
    }

    // Per-datanet isolation: a failure here (RPC error, rubric unavailable on an
    // older reppo CLI, a flaky adapter) skips THIS datanet and is recorded — it
    // never aborts the whole cycle or the other datanets.
    try {
      const rubric = await deps.reads.getRubric(datanetId)

      // One-time subnet access grant (fee gating, balance pre-check, grant, breadcrumb) —
      // see ensureSubnetAccess. A skip here stops the datanet BEFORE pod fetching and LLM
      // scoring are paid for; it resumes automatically once a later grant succeeds.
      const access = await ensureSubnetAccess(datanetId, policy, rubric, cycleId, deps)
      if (access.status === 'skipped') {
        datanets.push({ datanetId, votes, mints, skipped: access.reason })
        continue
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
        const scorerResult = deps.scorers.voteScorerFor(datanetId)
        if ('skip' in scorerResult) {
          // Per-datanet isolation: an unresolvable scoring model (e.g. no API key for the
          // datanet's chosen provider) skips THIS datanet's voting with a recorded reason —
          // never aborts the cycle. Record when otherwise idle so the dashboard explains it.
          recordSkip(`vote skipped — ${scorerResult.skip}`, { activity: votes.length === 0 })
        } else {
        const { pods, filter } = await deps.reads.getPodsAndFilter(datanetId)

        // Datanet economics: this epoch's REAL vote volume on-chain (the catalog's
        // upVoteVolume is lifetime-cumulative — useless for yield). Attached to a
        // vote-scoped rubric clone so the scorer prompt renders it (buildEconomicsBlock)
        // and reported on the snapshot. A failed/absent read ⇒ yield unavailable, NEVER
        // zero (a zero would fabricate "uncontested" from an RPC blip) — and never
        // aborts the datanet.
        let epochVotes: { epoch: number; totalRaw: bigint } | null = null
        let volumeReadError: string | undefined
        try {
          epochVotes = (await deps.onchain?.getEpochVoteVolume(pods.map((p) => p.podId))) ?? null
        } catch (e) {
          // Redact BEFORE the text leaves this scope: unavailableReason rides the
          // snapshot to the dashboard, a path with no redaction of its own (unlike
          // activity rows, which redactEntry scrubs on write) — an RPC error can echo
          // the full --rpc-url including an embedded provider API key.
          volumeReadError = redactSecrets(e instanceof Error ? e.message : String(e))
          console.error(`orquestra: datanet ${datanetId} — epoch vote volume read failed, yield omitted: ${volumeReadError}`)
        }
        const yld = computeYield(datanetId, rubric.economics, epochVotes)
        // Discriminate the two "unavailable" causes for the dashboard: an RPC failure
        // carries its (redacted) error, an RPC-less node shows plain "unavailable" —
        // the operator on the SSH-tunneled dashboard can't read stderr.
        if (volumeReadError) yld.unavailableReason = volumeReadError
        datanetEconomics.push(yld)
        // Yield is a VOTE-ONLY prompt signal — the VoteRubric/MintRubric split
        // (rubric/types.ts) makes yield-on-a-mint-prompt a compile error.
        const voteRubric = toVoteRubric(rubric, yld)
        // Stderr breadcrumb only. Yield is STATE, not an event — it reaches the
        // dashboard via the snapshot (Strategy-tab chips + Overview leaderboard), NOT
        // as activity rows: one info row per datanet per cycle drowned the real
        // vote/mint/claim events (~300 rows/day at 13 datanets × 1h cadence). The
        // 'info' activity kind remains in the schema for historical rows only.
        console.error(`orquestra: datanet ${datanetId} — ${formatYieldLine(yld)}${volumeReadError ? ` — read failed: ${volumeReadError}` : ''}`)

        // Per-pod scoring skips (e.g. a video ingest skip thrown from scorePod) surface as
        // dashboard activity here so an idle datanet explains why a pod produced no vote —
        // before this they were swallowed with only a stderr line. The reason is already
        // redacted by selectVotes.
        const intents = await selectVotes(datanetId, pods, voteRubric, policy.strictness, filter, scorerResult.scorer,
          (podId, reason) => recordSkipActivity(deps, cycleId, datanetId, `pod scoring skipped — ${reason}`, podId))
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
        const adapter = deps.adapters.get(policy.adapter)
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
            datanetId, rubric, topN: deps.adapters.topN,
            strategy: deps.adapters.strategyFor(datanetId),
            existingPodNames: await deps.adapters.existingPodNames(datanetId),
          })
          const seenKeys = await deps.dedup.seenKeysFor(datanetId)
          const minScore = STRICTNESS_THRESHOLDS[policy.strictness].like
          // toMintRubric: the mint path only ever holds a MintRubric (never yield).
          const intents = await selectMints(datanetId, candidates, toMintRubric(rubric), {
            dataDir: deps.dataDir, minScore, seenKeys, scorer: deps.scorers.candidateScorer,
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
            if (r.status === 'executed') deps.dedup.recordMint(datanetId, intent.canonicalKey)
            deps.activity.record({
              ts: new Date().toISOString(), cycleId, kind: 'mint', datanetId,
              canonicalKey: intent.canonicalKey, podName: intent.podName,
              // conviction+reason mirror the vote entry so the dashboard shows the
              // mint's score and rationale in Detail (not the canonical-key hash).
              ...(intent.selfScore !== undefined ? { conviction: intent.selfScore } : {}),
              ...(intent.reason ? { reason: intent.reason } : {}),
              status: r.status, txHash: r.txHash, gasEth: r.gasEth, detail: r.detail,
              ...(r.reppoSpent !== undefined ? { reppoSpent: r.reppoSpent } : {}),
              // podId from the on-chain PodMinted event (via mint-pod --json); enables
              // linking mint activity rows to their publisher emissions by pod ID.
              ...(r.podId ? { podId: r.podId } : {}),
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
      recordSkipActivity(deps, cycleId, datanetId, `datanet error: ${error}`)
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
      if (arr.length > 0) recordSkipActivity(deps, cycleId, id,
        `vote rate/budget cap reached — ${arr.length} vote${arr.length === 1 ? '' : 's'} deferred to next cycle`)
    }
  }

  // Global claim phase: emissions-due is one query across ALL our pods (not per
  // datanet). Claim every unclaimed (pod, epoch) we haven't already claimed.
  const claims: ExecResult[] = []
  // OWNER pairs still claimable after this cycle's claims — reused by the dashboard snapshot
  // so it doesn't re-scan PodManager a second time this cycle (see wiring.ts buildTick).
  let emissionsDue: ClaimableEmission[] = []
  if (config.claimEmissions) {
    let due: ClaimableEmission[] = []
    try {
      due = await deps.reads.getEmissionsDue()
    } catch (e) {
      console.error(`orquestra: emissions-due query failed, claim phase skipped this cycle — ${e instanceof Error ? e.message : String(e)}`)
    }
    const seen = await deps.dedup.seenClaims()
    claims.push(...await claimPhase(due, seen, cycleId, deps, {
      keyPrefix: '', idempotencyPrefix: 'claim-',
      execute: (i) => deps.executor.executeClaim(i),
      detail: (r) => r.detail,
    }))
    // Post-claim OWNER claimable: the scan result minus every (pod,epoch) now in `seen` (either
    // already-claimed before this cycle or claimed just now). The dashboard reads this — no
    // second on-chain scan — so "claimable" reflects exactly what a claim attempt didn't clear.
    emissionsDue = due.filter((em) => !seen.has(`${em.podId}:${em.epoch}`))

    // Voter emissions: a separate on-chain pool the wallet earns for curating OTHERS' pods
    // (claimVoterEmissions). Distinct claim path; dedup keys are prefixed `voter-` so they
    // never collide with owner-claim keys for the same (pod,epoch).
    let voterDue: ClaimableEmission[] = []
    try {
      voterDue = (await deps.onchain?.wallet?.getVoterEmissionsDue()) ?? []
    } catch (e) {
      console.error(`orquestra: voter emissions-due query failed, voter-claim skipped this cycle — ${e instanceof Error ? e.message : String(e)}`)
    }
    claims.push(...await claimPhase(voterDue, seen, cycleId, deps, {
      keyPrefix: 'voter-', idempotencyPrefix: 'claim-voter-',
      execute: (i) => deps.executor.executeVoterClaim(i),
      detail: (r) => r.detail ? `voter · ${r.detail}` : 'voter emissions',
    }))
  }

  return { datanets, claims, emissionsDue, datanetEconomics }
}
