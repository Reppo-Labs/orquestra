// The always-on eval worker loop. Runs BESIDE the scheduler, never inside the
// vote/mint cycle; every failure is caught here so evalwork can never affect
// voting or minting. The node is quorum-oblivious: lease → judge → submit,
// always — settlement is entirely the gateway's concern.
import { GatewayError, type GatewayClient } from './client.js'
import type { EvalBudget } from './budget.js'
import type { EvalJobRequest, LeasedJob } from './types.js'
import type { JudgeOutcome } from './judge.js'
import type { RankedPod } from './retrieve.js'
import { topKRelevant } from './retrieve.js'

export interface EvalWorkConfig {
  enabled: boolean
  maxConcurrent: number
}

export interface EvalActivityRow {
  ts: string
  kind: 'eval'
  jobId: string
  status: 'executed' | 'error' | 'skipped'
  reason: string
}

export interface EvalWorkerDeps {
  client: GatewayClient
  budget: EvalBudget
  /** Read live config each iteration — hot-reload for free. */
  getConfig: () => EvalWorkConfig
  /** The actual judge call; injected so the loop is testable without an LLM. */
  judge: (request: EvalJobRequest, evidence: RankedPod[]) => Promise<JudgeOutcome>
  /** Model id reported in answers (judge discipline: provenance names the model). */
  modelId: () => string
  record?: (row: EvalActivityRow) => void
  /** Idle delay between polls when disabled/at-capacity/out of budget. */
  idleMs?: number
  /** Extra attempts for :complete on transient failure (idempotent gateway-side). */
  completeRetries?: number
  log?: (msg: string) => void
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

  /** :complete with bounded retries — the gateway is idempotent per jobId+node,
   *  so resubmitting on a transient blip is safe and beats discarding a
   *  fully-computed (LLM-paid) judgment. */
  const submitWithRetry = async (answer: Parameters<GatewayClient['complete']>[0]): Promise<void> => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= completeRetries; attempt++) {
      try {
        await deps.client.complete(answer)
        return
      } catch (e) {
        lastErr = e
        if (attempt < completeRetries) {
          log(`:complete attempt ${attempt + 1} failed for job ${answer.jobId}, retrying: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    throw lastErr
  }

  async function serve(job: LeasedJob): Promise<void> {
    let submitted = false
    try {
      // Reserve BEFORE the judge call — the budget is a pre-spend gate.
      if (!deps.budget.reserve()) {
        await reportFail(job.jobId, 'node eval budget exhausted')
        safeRecord({ ts: new Date().toISOString(), kind: 'eval', jobId: job.jobId, status: 'skipped', reason: 'budget exhausted' })
        return
      }
      const corpus = await deps.client.fetchCorpus(job.corpusUrl)
      const evidence = topKRelevant(`${job.request.payload} ${job.request.criteria.join(' ')}`, corpus.pods)
      const outcome = await deps.judge(job.request, evidence)
      await submitWithRetry({
        jobId: job.jobId,
        model: deps.modelId(),
        verdicts: outcome.verdicts,
        evidenceBasis: outcome.evidenceBasis,
      })
      submitted = true
      safeRecord({
        ts: new Date().toISOString(),
        kind: 'eval',
        jobId: job.jobId,
        status: 'executed',
        reason: `judged ${outcome.verdicts.length} criteria (${outcome.evidenceBasis})`,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log(`job ${job.jobId} failed: ${e instanceof Error ? (e.stack ?? msg) : msg}`)
      safeRecord({ ts: new Date().toISOString(), kind: 'eval', jobId: job.jobId, status: 'error', reason: msg })
      // Only tell the gateway "I cannot serve this" when we truly didn't: a
      // bookkeeping error AFTER a successful :complete must not retract the
      // answer the gateway already accepted.
      if (!submitted) await reportFail(job.jobId, msg)
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
