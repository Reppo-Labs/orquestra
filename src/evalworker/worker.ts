// The always-on eval worker loop. Runs BESIDE the scheduler, never inside the
// vote/mint cycle; every failure is caught here so evalwork can never affect
// voting or minting. The node is quorum-oblivious: lease → judge → submit,
// always — settlement is entirely the gateway's concern.
import type { GatewayClient } from './client.js'
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
  status: 'executed' | 'skipped'
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
  log?: (msg: string) => void
}

export interface EvalWorkerHandle {
  stop(): Promise<void>
}

export function startEvalWorker(deps: EvalWorkerDeps): EvalWorkerHandle {
  const log = deps.log ?? ((m: string) => console.error(`orquestra: evalwork: ${m}`))
  const idleMs = deps.idleMs ?? 30_000
  const inFlight = new Set<Promise<void>>()
  let stopped = false
  let wake: (() => void) | undefined

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve
      setTimeout(resolve, ms)
    })

  async function serve(job: LeasedJob): Promise<void> {
    try {
      // Reserve BEFORE the judge call — the budget is a pre-spend gate.
      if (!deps.budget.reserve()) {
        await deps.client.fail(job.jobId, 'node eval budget exhausted')
        deps.record?.({ ts: new Date().toISOString(), kind: 'eval', jobId: job.jobId, status: 'skipped', reason: 'budget exhausted' })
        return
      }
      const corpus = await deps.client.fetchCorpus(job.corpusUrl)
      const evidence = topKRelevant(`${job.request.payload} ${job.request.criteria.join(' ')}`, corpus.pods)
      const outcome = await deps.judge(job.request, evidence)
      await deps.client.complete({
        jobId: job.jobId,
        model: deps.modelId(),
        verdicts: outcome.verdicts,
        evidenceBasis: outcome.evidenceBasis,
      })
      deps.record?.({
        ts: new Date().toISOString(),
        kind: 'eval',
        jobId: job.jobId,
        status: 'executed',
        reason: `judged ${outcome.verdicts.length} criteria (${outcome.evidenceBasis})`,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log(`job ${job.jobId} failed: ${msg}`)
      deps.record?.({ ts: new Date().toISOString(), kind: 'eval', jobId: job.jobId, status: 'skipped', reason: msg })
      try {
        await deps.client.fail(job.jobId, msg)
      } catch {
        // gateway unreachable — the lease simply expires server-side
      }
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
        if (stopped) break
        if (!job) {
          // Empty long-poll: yield through a macrotask before re-polling. The
          // real gateway blocks ~25s so this is free in production; without it
          // an immediately-resolving lease (tests, local stubs) busy-spins on
          // microtasks and starves the event loop's timers.
          await sleep(0)
          continue
        }
        const p = serve(job).finally(() => inFlight.delete(p))
        inFlight.add(p)
      } catch (e) {
        // Lease/network errors: back off, never escalate — isolation from vote/mint.
        log(`lease loop error (backing off): ${e instanceof Error ? e.message : String(e)}`)
        await sleep(idleMs)
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
