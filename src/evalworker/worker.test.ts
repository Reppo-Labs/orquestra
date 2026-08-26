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
  leaseExpiresAt: new Date(Date.now() + 240_000).toISOString(),
  settlementDeadline: new Date(Date.now() + 300_000).toISOString(),
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
