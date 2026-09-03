// The always-on eval worker loop. Runs BESIDE the scheduler, never inside the
// vote/mint cycle; every failure is caught here so evalwork can never affect
// voting or minting. The node is quorum-oblivious: lease → retrieve → gate →
// judge → submit (or deny), always — settlement is entirely the gateway's
// concern. Evidence is node-side (eval-datanet-grounding design D5): the node
// grounds every verdict in pods it read itself, and denies the job when the
// relevance gate finds nothing for a criterion — never judges without evidence.
import { GatewayError, type GatewayClient } from './client.js'
import type { EvalBudget } from './budget.js'
import type { DatanetSource } from './datanet.js'
import type { GateResult } from './gate.js'
import type { EvalJobRequest, LeasedJob } from './types.js'
import type { GatedEvidence, JudgeOutcome } from './judge.js'
import type { RankedPod } from './retrieve.js'
import { gatherEvidence } from './retrieve.js'

export interface EvalWorkConfig {
  enabled: boolean
  maxConcurrent: number
}

export interface EvalActivityRow {
  ts: string
  kind: 'eval'
  jobId: string
  status: 'executed' | 'denied' | 'error' | 'skipped'
  reason: string
}

export interface EvalWorkerDeps {
  client: GatewayClient
  budget: EvalBudget
  /** Read live config each iteration — hot-reload for free. */
  getConfig: () => EvalWorkConfig
  /** Where this node reads evidence: the datanets its credentials can access. */
  datanet: DatanetSource
  /** The relevance gate (one LLM call); injected so the loop is testable without an LLM. */
  gate: (request: EvalJobRequest, candidates: RankedPod[]) => Promise<GateResult>
  /** The actual judge call; injected so the loop is testable without an LLM. */
  judge: (request: EvalJobRequest, gated: GatedEvidence) => Promise<JudgeOutcome>
  /** Model id reported in answers (judge discipline: provenance names the model). */
  modelId: () => string
  record?: (row: EvalActivityRow) => void
  /** Idle delay between polls when disabled/at-capacity/out of budget. */
  idleMs?: number
  /** Extra attempts for :complete / :deny on transient failure (idempotent gateway-side). */
  completeRetries?: number
  log?: (msg: string) => void
}

/** The gateway caps a denial reason at 2000 characters (eval-api
 *  `denyRequestSchema`) while intake caps the criteria COUNT (10), not their
 *  length — so the full text of ten long criteria overflows the cap, and a 400
 *  INVALID_DENIAL is terminal here: every node would :fail and the job would
 *  settle `failed` instead of `denied`. Name each unsupported criterion by its
 *  1-based index with a bounded excerpt, and hard-clamp the whole string.
 *  ASCII-only truncation markers so length in characters == length in bytes. */
export const DENY_REASON_MAX = 2000
const CRITERION_EXCERPT_MAX = 120

const excerpt = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > CRITERION_EXCERPT_MAX ? `${flat.slice(0, CRITERION_EXCERPT_MAX - 3)}...` : flat
}

export function buildDenyReason(unsupported: string[], criteria: string[], datanetsSearched: number[]): string {
  const named = unsupported.map((c) => {
    const i = criteria.indexOf(c)
    return `${i >= 0 ? `#${i + 1}` : '#?'} "${excerpt(c)}"`
  })
  const reason =
    `no pod on the datanets this node can read bears on criteria ${named.join(', ')}` +
    ` (searched datanets ${datanetsSearched.join(', ')})`
  return reason.length > DENY_REASON_MAX ? `${reason.slice(0, DENY_REASON_MAX - 3)}...` : reason
}

export interface EvalWorkerHandle {
  stop(): Promise<void>
}

export function startEvalWorker(deps: EvalWorkerDeps): EvalWorkerHandle {
  const log = deps.log ?? ((m: string) => console.error(`orquestra: evalwork: ${m}`))
  const idleMs = deps.idleMs ?? 30_000
  const completeRetries = deps.completeRetries ?? 2
  const inFlight = new Set<Promise<void>>()
  let stopped = false
  let wake: (() => void) | undefined

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve
      setTimeout(resolve, ms)
    })

  // The observability channels themselves must never become crash vectors: a
  // locked activity DB while recording an eval row would otherwise escape
  // serve() as an unhandled rejection and take the NODE down — the exact
  // failure class this module promises cannot happen.
  const safeRecord = (row: EvalActivityRow): void => {
    try {
      deps.record?.(row)
    } catch (e) {
      try {
        log(`activity record failed for job ${row.jobId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
      } catch {
        /* even the logger failing must not escape */
      }
    }
  }

  const reportFail = async (jobId: string, reason: string): Promise<void> => {
    try {
      await deps.client.fail(jobId, reason)
    } catch (e) {
      // Not silent: without this line the operator cannot distinguish "fail
      // reported cleanly" from "job dangles until lease expiry server-side".
      log(`could not report :fail for job ${jobId} (lease will expire server-side): ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** A gateway submission with bounded retries — :complete and :deny are both
   *  idempotent per jobId+node, so resubmitting on a transient blip is safe
   *  and beats discarding a fully-computed (LLM-paid) outcome. */
  const submitWithRetry = async (jobId: string, label: 'complete' | 'deny', send: () => Promise<void>): Promise<void> => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= completeRetries; attempt++) {
      try {
        await send()
        return
      } catch (e) {
        lastErr = e
        // Deterministic gateway rejections (400 JOB_ID_MISMATCH / INVALID_DENIAL,
        // 409 PAST_CUTOFF / ALREADY_ANSWERED, 422 CRITERIA_MISMATCH /
        // UNGROUNDED_VERDICT / UNRESOLVABLE_CITATION — see the error-codes.json
        // contract fixture) never change on resend; retrying only wastes
        // traffic. 408/429 stay retryable.
        if (e instanceof GatewayError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
          throw e
        }
        if (attempt < completeRetries) {
          log(`:${label} attempt ${attempt + 1} failed for job ${jobId}, retrying: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    throw lastErr
  }

  async function serve(job: LeasedJob): Promise<void> {
    let submitted = false
    try {
      // Past the epoch answer cut-off the gateway rejects every answer —
      // judging would spend LLM budget on a guaranteed 409. Hand it back.
      if (Date.parse(job.answerCutoff) < Date.now()) {
        await reportFail(job.jobId, 'answer cut-off already passed')
        safeRecord({ ts: new Date().toISOString(), kind: 'eval', jobId: job.jobId, status: 'skipped', reason: 'past answer cut-off' })
        return
      }
      // Reserve BEFORE retrieval — the budget is a pre-spend gate, and one
      // reservation covers gate + judge (they are one job's spend).
      if (!deps.budget.reserve()) {
        await reportFail(job.jobId, 'node eval budget exhausted')
        safeRecord({ ts: new Date().toISOString(), kind: 'eval', jobId: job.jobId, status: 'skipped', reason: 'budget exhausted' })
        return
      }
      // A source failure throws out of here → :fail (retryable). It must never
      // read as "no evidence": an outage is not a denial.
      const evidence = await gatherEvidence(deps.datanet, job.request)
      if (evidence.datanetsSearched.length === 0) {
        // The gateway refuses a denial naming no datanet (400 INVALID_DENIAL),
        // and a node that can read nothing is misconfigured, not uninformed.
        throw new Error('no accessible datanets — this node cannot ground any verdict (check the node credentials / EVAL_DATANET_API_URL)')
      }
      const gate = await deps.gate(job.request, evidence.candidates)
      if (gate.unsupported.length > 0) {
        const reason = buildDenyReason(gate.unsupported, job.request.criteria, evidence.datanetsSearched)
        await submitWithRetry(job.jobId, 'deny', () => deps.client.deny(job.jobId, reason, evidence.datanetsSearched))
        submitted = true
        safeRecord({ ts: new Date().toISOString(), kind: 'eval', jobId: job.jobId, status: 'denied', reason })
        return
      }
      const outcome = await deps.judge(job.request, gate.supported)
      const answer = { jobId: job.jobId, model: deps.modelId(), verdicts: outcome.verdicts }
      await submitWithRetry(job.jobId, 'complete', () => deps.client.complete(answer))
      submitted = true
      const cited = outcome.verdicts.reduce((n, v) => n + v.citations.length, 0)
      safeRecord({
        ts: new Date().toISOString(),
        kind: 'eval',
        jobId: job.jobId,
        status: 'executed',
        reason: `judged ${outcome.verdicts.length} criteria, ${cited} citation(s) across datanets ${evidence.datanetsSearched.join(', ')}`,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log(`job ${job.jobId} failed: ${e instanceof Error ? (e.stack ?? msg) : msg}`)
      safeRecord({ ts: new Date().toISOString(), kind: 'eval', jobId: job.jobId, status: 'error', reason: msg })
      // Only tell the gateway "I cannot serve this" when we truly didn't: a
      // bookkeeping error AFTER a successful :complete/:deny must not retract
      // what the gateway already accepted. A 409/422 on :complete, or a 409
      // on :deny (ALREADY_ANSWERED / PAST_CUTOFF), means the gateway
      // ADJUDICATED the job — a :fail on top would double-record.
      const adjudicated = e instanceof GatewayError && (e.status === 409 || e.status === 422)
      if (!submitted && !adjudicated) await reportFail(job.jobId, msg)
    }
  }

  const loop = (async () => {
    while (!stopped) {
      try {
        const cfg = deps.getConfig()
        if (!cfg.enabled || inFlight.size >= cfg.maxConcurrent || !deps.budget.hasBudget()) {
          await sleep(idleMs)
          continue
        }
        const job = await deps.client.lease()
        if (stopped) {
          // A lease that resolved WITH a job during shutdown: hand it back
          // explicitly instead of ghosting (which would pin it server-side
          // until lease expiry with zero trace on this node).
          if (job) {
            log(`job ${job.jobId} leased during shutdown — reporting :fail`)
            await reportFail(job.jobId, 'node shutting down')
          }
          break
        }
        if (!job) {
          // Empty long-poll: yield through a macrotask before re-polling. The
          // real gateway blocks ~25s so this is free in production; without it
          // an immediately-resolving lease (tests, local stubs) busy-spins on
          // microtasks and starves the event loop's timers.
          await sleep(0)
          continue
        }
        // Belt on top of serve()'s own try/catch: nothing may escape as an
        // unhandled rejection, whatever future edits do inside serve.
        const p = serve(job)
          .catch((e) => log(`serve escaped its own handler (bug): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`))
          .finally(() => inFlight.delete(p))
        inFlight.add(p)
      } catch (e) {
        // Lease/network errors: back off, never escalate — isolation from vote/mint.
        // Auth rejections get a distinct, actionable message and a longer backoff:
        // retrying a bad key every 30s is noise, not liveness.
        if (e instanceof GatewayError && (e.status === 401 || e.status === 403)) {
          log(`gateway rejected this node's credentials (HTTP ${e.status}) — check REPPO_AGENT_ID/REPPO_API_KEY: ${e.message}`)
          await sleep(idleMs * 10)
        } else {
          log(`lease loop error (backing off): ${e instanceof Error ? e.message : String(e)}`)
          await sleep(idleMs)
        }
      }
    }
    await Promise.allSettled([...inFlight])
  })()

  return {
    async stop() {
      stopped = true
      wake?.()
      await loop
    },
  }
}
