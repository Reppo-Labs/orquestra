import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvalBudget } from './budget.js'
import { startEvalWorker, type EvalWorkerDeps } from './worker.js'
import type { GatewayClient } from './client.js'
import type { LeasedJob } from './types.js'

const job = (id: string): LeasedJob => ({
  jobId: id,
  request: { type: 'answer', payload: 'the payload', criteria: ['is good'] },
  datanetId: 1,
  corpusUrl: 'https://example.com/corpus.json',
  corpusVersion: '20260826T110000Z',
  epoch: 128,
  answerCutoff: new Date(Date.now() + 300_000).toISOString(),
})

const corpus = { datanetId: 1, generatedAt: new Date().toISOString(), pods: [] }

function makeClient(jobs: (LeasedJob | null)[]): GatewayClient & { completed: unknown[]; failed: unknown[] } {
  const queue = [...jobs]
  const completed: unknown[] = []
  const failed: unknown[] = []
  return {
    completed,
    failed,
    lease: vi.fn(async () => queue.shift() ?? null),
    complete: vi.fn(async (a: unknown) => {
      completed.push(a)
    }),
    fail: vi.fn(async (id: string, reason: string) => {
      failed.push({ id, reason })
    }),
    fetchCorpus: vi.fn(async () => corpus),
  } as unknown as GatewayClient & { completed: unknown[]; failed: unknown[] }
}

const budget = (cap: number) =>
  new EvalBudget(join(mkdtempSync(join(tmpdir(), 'evalw-')), 'b.json'), () => cap)

function deps(over: Partial<EvalWorkerDeps>): EvalWorkerDeps {
  return {
    client: makeClient([]),
    budget: budget(100),
    getConfig: () => ({ enabled: true, maxConcurrent: 2 }),
    judge: async (req) => ({
      verdicts: req.criteria.map((criterion) => ({ criterion, score: 7, critique: 'ok', citations: [] })),
      evidenceBasis: 'model-judgment' as const,
    }),
    modelId: () => 'test/model',
    idleMs: 5,
    log: () => {},
    ...over,
  }
}

const waitFor = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('startEvalWorker', () => {
  it('leases, judges, submits — always (quorum-oblivious)', async () => {
    const client = makeClient([job('j1'), job('j2'), null])
    const rows: unknown[] = []
    const w = startEvalWorker(deps({ client, record: (r) => rows.push(r) }))
    await waitFor(() => client.completed.length === 2)
    await w.stop()
    expect(client.completed).toHaveLength(2)
    expect(rows).toHaveLength(2)
    expect((client.completed[0] as { model: string }).model).toBe('test/model')
  })

  it('stops leasing when disabled (hot-reload)', async () => {
    const client = makeClient([job('j1')])
    let enabled = false
    const w = startEvalWorker(deps({ client, getConfig: () => ({ enabled, maxConcurrent: 2 }) }))
    await new Promise((r) => setTimeout(r, 40))
    expect(client.lease).not.toHaveBeenCalled()
    enabled = true
    await waitFor(() => client.completed.length === 1)
    await w.stop()
  })

  it('budget exhaustion stops serving; in-flight work completes', async () => {
    const client = makeClient([job('j1'), job('j2'), job('j3'), null])
    const w = startEvalWorker(deps({ client, budget: budget(1) }))
    await waitFor(() => client.completed.length === 1)
    // give the loop time to (incorrectly) serve more — it must not
    await new Promise((r) => setTimeout(r, 60))
    await w.stop()
    expect(client.completed).toHaveLength(1)
  })

  it('judge failure → :fail, never throws out of the loop (isolation)', async () => {
    const client = makeClient([job('bad'), null])
    const w = startEvalWorker(
      deps({
        client,
        judge: async () => {
          throw new Error('model exploded')
        },
      }),
    )
    await waitFor(() => client.failed.length === 1)
    await w.stop()
    expect(client.failed[0]).toMatchObject({ id: 'bad', reason: 'model exploded' })
    expect(client.completed).toHaveLength(0)
  })

  it('lease errors back off instead of crashing', async () => {
    const client = makeClient([])
    ;(client.lease as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'))
    const w = startEvalWorker(deps({ client }))
    await new Promise((r) => setTimeout(r, 30))
    await w.stop() // reaching here without an unhandled rejection is the assertion
  })
})

// ── Review-driven regression tests (PR #205) ─────────────────────────────────

const deferred = <T,>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('startEvalWorker (review regressions)', () => {
  it('a throwing record() never escapes — the node survives (critical #1)', async () => {
    const client = makeClient([job('j1'), null])
    const w = startEvalWorker(
      deps({
        client,
        record: () => {
          throw new Error('SQLITE_BUSY')
        },
      }),
    )
    await waitFor(() => client.completed.length === 1)
    await w.stop() // no unhandled rejection = the assertion
    expect(client.completed).toHaveLength(1)
    // record threw AFTER complete succeeded: gateway must NOT get a :fail
    expect(client.failed).toHaveLength(0)
  })

  it('no :fail after a successful :complete when bookkeeping errors', async () => {
    const client = makeClient([job('j1'), null])
    let calls = 0
    const w = startEvalWorker(
      deps({
        client,
        record: () => {
          calls++
          if (calls === 1) throw new Error('disk full')
        },
      }),
    )
    await waitFor(() => client.completed.length === 1)
    await w.stop()
    expect(client.failed).toHaveLength(0)
  })

  it(':complete retries transient failures before giving up (idempotent resubmit)', async () => {
    const client = makeClient([job('j1'), null])
    const complete = client.complete as ReturnType<typeof vi.fn>
    complete.mockRejectedValueOnce(new Error('ECONNRESET'))
    const w = startEvalWorker(deps({ client }))
    await waitFor(() => client.completed.length === 1)
    await w.stop()
    expect(complete).toHaveBeenCalledTimes(2)
    expect(client.failed).toHaveLength(0)
  })

  it('budget exhausts while a slow judge is in flight: in-flight completes, no further leasing', async () => {
    // reserve() runs synchronously inside serve() before its first await, so
    // the loop's next hasBudget() check already sees the spent slot — a second
    // job is never even leased (no lease/reserve race to burn jobs on).
    const gate = deferred<void>()
    const client = makeClient([job('j1'), job('j2'), null])
    const w = startEvalWorker(
      deps({
        client,
        budget: budget(1),
        judge: async (req) => {
          await gate.promise
          return {
            verdicts: req.criteria.map((criterion) => ({ criterion, score: 7, critique: 'ok', citations: [] })),
            evidenceBasis: 'model-judgment' as const,
          }
        },
      }),
    )
    // j1 is being served (corpus fetched) and holds the only budget slot
    await waitFor(() => (client.fetchCorpus as ReturnType<typeof vi.fn>).mock.calls.length === 1)
    const leaseCallsAtExhaustion = (client.lease as ReturnType<typeof vi.fn>).mock.calls.length
    await new Promise((r) => setTimeout(r, 30))
    expect((client.lease as ReturnType<typeof vi.fn>).mock.calls.length).toBe(leaseCallsAtExhaustion)
    expect(client.failed).toHaveLength(0) // nothing leased-then-refused
    gate.resolve()
    await waitFor(() => client.completed.length === 1)
    await w.stop()
    expect(client.completed).toHaveLength(1) // in-flight completed despite exhaustion
  })

  it('stop() drains an in-flight job before resolving', async () => {
    const gate = deferred<void>()
    const client = makeClient([job('slow'), null])
    const w = startEvalWorker(
      deps({
        client,
        judge: async (req) => {
          await gate.promise
          return {
            verdicts: req.criteria.map((criterion) => ({ criterion, score: 7, critique: 'ok', citations: [] })),
            evidenceBasis: 'model-judgment' as const,
          }
        },
      }),
    )
    await waitFor(() => (client.fetchCorpus as ReturnType<typeof vi.fn>).mock.calls.length === 1)
    const stopping = w.stop()
    gate.resolve()
    await stopping
    expect(client.completed).toHaveLength(1)
  })

  it('respects maxConcurrent: never more than N judges in flight', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
    let running = 0
    let peak = 0
    let started = 0
    const client = makeClient([job('a'), job('b'), job('c'), null])
    const w = startEvalWorker(
      deps({
        client,
        getConfig: () => ({ enabled: true, maxConcurrent: 2 }),
        judge: async (req) => {
          const gate = gates[started++]!
          running++
          peak = Math.max(peak, running)
          await gate.promise
          running--
          return {
            verdicts: req.criteria.map((criterion) => ({ criterion, score: 7, critique: 'ok', citations: [] })),
            evidenceBasis: 'model-judgment' as const,
          }
        },
      }),
    )
    await waitFor(() => started === 2)
    // capacity reached: give the loop room to (incorrectly) start a third
    await new Promise((r) => setTimeout(r, 30))
    expect(peak).toBe(2)
    gates[0]!.resolve()
    await waitFor(() => started === 3)
    gates[1]!.resolve()
    gates[2]!.resolve()
    await waitFor(() => client.completed.length === 3)
    await w.stop()
    expect(peak).toBe(2)
  })

  it('a job leased during shutdown is handed back via :fail, not ghosted', async () => {
    const leaseGate = deferred<LeasedJob>()
    const client = makeClient([])
    ;(client.lease as ReturnType<typeof vi.fn>).mockImplementation(() => leaseGate.promise)
    const w = startEvalWorker(deps({ client }))
    await waitFor(() => (client.lease as ReturnType<typeof vi.fn>).mock.calls.length === 1)
    const stopping = w.stop()
    leaseGate.resolve(job('late'))
    await stopping
    expect(client.failed).toHaveLength(1)
    expect(client.failed[0]).toMatchObject({ id: 'late', reason: 'node shutting down' })
    expect(client.completed).toHaveLength(0)
  })
})
