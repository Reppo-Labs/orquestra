import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvalBudget } from './budget.js'
import { buildDenyReason, startEvalWorker, type EvalWorkerDeps } from './worker.js'
import { GatewayError, type GatewayClient } from './client.js'
import { InMemoryDatanetSource, type DatanetSource } from './datanet.js'
import type { DatanetPod, LeasedJob } from './types.js'
import type { GateResult } from './gate.js'

const job = (id: string): LeasedJob => ({
  jobId: id,
  request: { type: 'answer', payload: 'the payload is good', criteria: ['is good'] },
  epoch: 128,
  answerCutoff: new Date(Date.now() + 300_000).toISOString(),
})

const pod: DatanetPod = { datanetId: 27, podId: '482', name: 'good things', text: 'the payload is good evidence' }

/** One accessible datanet holding one pod that lexically matches every job above. */
const datanet = (): DatanetSource => new InMemoryDatanetSource([{ datanetId: 27, name: 'perps', pods: [pod] }])

/** Gate that admits every candidate for every criterion. */
const admitAll = async (req: { criteria: string[] }, cands: { pod: DatanetPod }[]): Promise<GateResult> => ({
  supported: new Map(req.criteria.map((c) => [c, cands.map((x) => x.pod)])),
  unsupported: [],
  datanetsSearched: [...new Set(cands.map((x) => x.pod.datanetId))],
})

type TestClient = GatewayClient & { completed: unknown[]; failed: unknown[]; denied: unknown[] }

function makeClient(jobs: (LeasedJob | null)[]): TestClient {
  const queue = [...jobs]
  const completed: unknown[] = []
  const failed: unknown[] = []
  const denied: unknown[] = []
  return {
    completed,
    failed,
    denied,
    lease: vi.fn(async () => queue.shift() ?? null),
    complete: vi.fn(async (a: unknown) => {
      completed.push(a)
    }),
    fail: vi.fn(async (id: string, reason: string) => {
      failed.push({ id, reason })
    }),
    deny: vi.fn(async (id: string, reason: string, datanetsSearched: number[]) => {
      denied.push({ id, reason, datanetsSearched })
    }),
  } as unknown as TestClient
}

const budget = (cap: number) =>
  new EvalBudget(join(mkdtempSync(join(tmpdir(), 'evalw-')), 'b.json'), () => cap)

function deps(over: Partial<EvalWorkerDeps>): EvalWorkerDeps {
  return {
    client: makeClient([]),
    budget: budget(100),
    getConfig: () => ({ enabled: true, maxConcurrent: 2 }),
    datanet: datanet(),
    gate: admitAll,
    judge: async (req, gated) => ({
      verdicts: req.criteria.map((criterion) => ({
        criterion,
        score: 7,
        critique: 'ok',
        citations: (gated.get(criterion) ?? []).map((p) => ({ datanetId: p.datanetId, podId: p.podId })),
      })),
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
    expect((client.completed[0] as { verdicts: { citations: unknown[] }[] }).verdicts[0]?.citations).toEqual([{ datanetId: 27, podId: '482' }])
    expect(rows[0]).toMatchObject({ status: 'executed' })
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
  it('a deterministic 4xx on :complete is not retried and not double-recorded via :fail', async () => {
    const client = makeClient([job('j-422'), null])
    const complete = client.complete as ReturnType<typeof vi.fn>
    complete.mockRejectedValue(new GatewayError(422, 'complete failed: HTTP 422 UNRESOLVABLE_CITATION'))
    const d = deps({ client })
    const w = startEvalWorker(d)
    await waitFor(() => complete.mock.calls.length >= 1)
    await new Promise((r) => setTimeout(r, 50))
    await w.stop()
    expect(complete.mock.calls.length).toBe(1) // no retries on a permanent rejection
    expect(client.failed).toHaveLength(0) // the gateway already adjudicated; no :fail on top
  })

  it('a 429 on :complete stays retryable', async () => {
    const client = makeClient([job('j-429'), null])
    const complete = client.complete as ReturnType<typeof vi.fn>
    complete
      .mockRejectedValueOnce(new GatewayError(429, 'complete failed: HTTP 429'))
      .mockResolvedValueOnce(undefined)
    const w = startEvalWorker(deps({ client }))
    await waitFor(() => complete.mock.calls.length >= 2)
    await w.stop()
    expect(complete.mock.calls.length).toBe(2)
    expect(client.failed).toHaveLength(0)
  })

  it('a job already past its answer cut-off is handed back without judging or spending budget', async () => {
    const stale = { ...job('j-late'), answerCutoff: new Date(Date.now() - 1000).toISOString() }
    const client = makeClient([stale, null])
    const judge = vi.fn()
    const w = startEvalWorker(deps({ client, judge }))
    await waitFor(() => client.failed.length >= 1)
    await w.stop()
    expect(judge).not.toHaveBeenCalled()
    expect(client.failed[0]).toMatchObject({ id: 'j-late', reason: 'answer cut-off already passed' })
  })

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
    let judgeStarted = 0
    const w = startEvalWorker(
      deps({
        client,
        budget: budget(1),
        judge: async (req) => {
          judgeStarted++
          await gate.promise
          return { verdicts: req.criteria.map((criterion) => ({ criterion, score: 7, critique: 'ok', citations: [{ datanetId: 27, podId: '482' }] })) }
        },
      }),
    )
    // j1 is being served (judge entered) and holds the only budget slot
    await waitFor(() => judgeStarted === 1)
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
    let judgeStarted = 0
    const w = startEvalWorker(
      deps({
        client,
        judge: async (req) => {
          judgeStarted++
          await gate.promise
          return { verdicts: req.criteria.map((criterion) => ({ criterion, score: 7, critique: 'ok', citations: [{ datanetId: 27, podId: '482' }] })) }
        },
      }),
    )
    await waitFor(() => judgeStarted === 1)
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
          return { verdicts: req.criteria.map((criterion) => ({ criterion, score: 7, critique: 'ok', citations: [{ datanetId: 27, podId: '482' }] })) }
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

// ── eval-datanet-grounding: deny path, evidence errors, budget ordering ──────

describe('startEvalWorker (datanet grounding)', () => {
  it('gate leaves a criterion unsupported → :deny with the criteria named and the datanets searched; never :complete', async () => {
    const client = makeClient([job('j-deny'), null])
    const rows: { status: string; reason: string }[] = []
    const judge = vi.fn()
    const w = startEvalWorker(
      deps({
        client,
        judge,
        gate: async () => ({ supported: new Map(), unsupported: ['is good'], datanetsSearched: [27] }),
        record: (r) => rows.push(r),
      }),
    )
    await waitFor(() => client.denied.length === 1)
    await w.stop()
    expect(client.denied[0]).toMatchObject({ id: 'j-deny', datanetsSearched: [27] })
    expect((client.denied[0] as { reason: string }).reason).toContain('is good')
    expect(judge).not.toHaveBeenCalled()
    expect(client.completed).toHaveLength(0)
    expect(client.failed).toHaveLength(0)
    expect(rows[0]).toMatchObject({ status: 'denied', jobId: 'j-deny' })
    expect(rows[0]?.reason).toContain('is good')
  })

  it('zero candidates (nothing relevant on any datanet) → :deny naming every datanet read, without a gate/judge call', async () => {
    const client = makeClient([job('j-empty'), null])
    const gate = vi.fn(async (): Promise<GateResult> => ({ supported: new Map(), unsupported: ['is good'], datanetsSearched: [] }))
    const w = startEvalWorker(
      deps({
        client,
        gate,
        datanet: new InMemoryDatanetSource([
          { datanetId: 27, name: 'a', pods: [{ datanetId: 27, podId: '1', name: 'cats', text: 'felines purring' }] },
          { datanetId: 31, name: 'b', pods: [] },
        ]),
      }),
    )
    await waitFor(() => client.denied.length === 1)
    await w.stop()
    // the injected gate is what decides; the worker still reports every datanet it READ
    expect(client.denied[0]).toMatchObject({ id: 'j-empty', datanetsSearched: [27, 31] })
    expect(client.completed).toHaveLength(0)
  })

  it('datanet source error → :fail (retryable), never deny or judge', async () => {
    const client = makeClient([job('j-src'), null])
    const judge = vi.fn()
    const gate = vi.fn()
    const w = startEvalWorker(
      deps({
        client,
        judge,
        gate,
        datanet: {
          listAccessible: async () => {
            throw new Error('datanet api HTTP 503')
          },
          fetchPods: async () => [],
        },
      }),
    )
    await waitFor(() => client.failed.length === 1)
    await w.stop()
    expect(client.failed[0]).toMatchObject({ id: 'j-src', reason: expect.stringContaining('HTTP 503') })
    expect(client.denied).toHaveLength(0)
    expect(gate).not.toHaveBeenCalled()
    expect(judge).not.toHaveBeenCalled()
  })

  it('no accessible datanets at all → :fail (a denial must name a datanet; this is node config, not evidence)', async () => {
    const client = makeClient([job('j-none'), null])
    const w = startEvalWorker(deps({ client, datanet: new InMemoryDatanetSource([]) }))
    await waitFor(() => client.failed.length === 1)
    await w.stop()
    expect(client.failed[0]).toMatchObject({ id: 'j-none', reason: expect.stringMatching(/no accessible datanets/i) })
    expect(client.denied).toHaveLength(0)
  })

  it('gate error → :fail', async () => {
    const client = makeClient([job('j-gate'), null])
    const w = startEvalWorker(
      deps({
        client,
        gate: async () => {
          throw new Error('gate omitted criterion: is good')
        },
      }),
    )
    await waitFor(() => client.failed.length === 1)
    await w.stop()
    expect(client.failed[0]).toMatchObject({ id: 'j-gate', reason: 'gate omitted criterion: is good' })
    expect(client.denied).toHaveLength(0)
    expect(client.completed).toHaveLength(0)
  })

  it('judge cites nothing → :fail, nothing submitted', async () => {
    const client = makeClient([job('j-uncited'), null])
    const w = startEvalWorker(
      deps({
        client,
        judge: async () => {
          throw new Error('judge cited nothing for criterion: is good')
        },
      }),
    )
    await waitFor(() => client.failed.length === 1)
    await w.stop()
    expect(client.failed[0]).toMatchObject({ id: 'j-uncited', reason: 'judge cited nothing for criterion: is good' })
    expect(client.completed).toHaveLength(0)
  })

  it('budget is reserved before retrieval: exhausted → :fail without touching the datanet source', async () => {
    const client = makeClient([job('j-budget'), null])
    const listAccessible = vi.fn(async () => [{ datanetId: 27, name: 'a' }])
    const w = startEvalWorker(deps({ client, budget: budget(0), datanet: { listAccessible, fetchPods: async () => [] } }))
    // hasBudget() is false from the start, so the loop never leases — give it room to misbehave
    await new Promise((r) => setTimeout(r, 40))
    await w.stop()
    expect(listAccessible).not.toHaveBeenCalled()
    expect(client.lease).not.toHaveBeenCalled()
  })

  it('a denial spends one budget reservation (the gate is an LLM call)', async () => {
    const client = makeClient([job('j1'), job('j2'), null])
    const b = budget(1)
    const w = startEvalWorker(deps({ client, budget: b, gate: async () => ({ supported: new Map(), unsupported: ['is good'], datanetsSearched: [27] }) }))
    await waitFor(() => client.denied.length === 1)
    await new Promise((r) => setTimeout(r, 40))
    await w.stop()
    expect(b.usedToday()).toBe(1)
    expect(client.denied).toHaveLength(1)
  })

  it(':deny 409 ALREADY_ANSWERED is terminal and adjudicated — no retry, no :fail on top', async () => {
    const client = makeClient([job('j-409'), null])
    const deny = client.deny as ReturnType<typeof vi.fn>
    deny.mockRejectedValue(new GatewayError(409, 'deny failed: HTTP 409 ALREADY_ANSWERED'))
    const rows: { status: string }[] = []
    const w = startEvalWorker(
      deps({ client, gate: async () => ({ supported: new Map(), unsupported: ['is good'], datanetsSearched: [27] }), record: (r) => rows.push(r) }),
    )
    await waitFor(() => deny.mock.calls.length >= 1)
    await new Promise((r) => setTimeout(r, 50))
    await w.stop()
    expect(deny.mock.calls.length).toBe(1)
    expect(client.failed).toHaveLength(0)
    expect(rows[0]).toMatchObject({ status: 'error' })
  })

  it(':deny 400 INVALID_DENIAL is terminal (no retry) but not adjudicated → :fail reported', async () => {
    const client = makeClient([job('j-400'), null])
    const deny = client.deny as ReturnType<typeof vi.fn>
    deny.mockRejectedValue(new GatewayError(400, 'deny failed: HTTP 400 INVALID_DENIAL'))
    const w = startEvalWorker(deps({ client, gate: async () => ({ supported: new Map(), unsupported: ['is good'], datanetsSearched: [27] }) }))
    await waitFor(() => client.failed.length === 1)
    await w.stop()
    expect(deny.mock.calls.length).toBe(1)
    expect(client.failed[0]).toMatchObject({ id: 'j-400' })
  })

  it(':deny retries a transient failure (429) before giving up', async () => {
    const client = makeClient([job('j-d429'), null])
    const deny = client.deny as ReturnType<typeof vi.fn>
    deny.mockRejectedValueOnce(new GatewayError(429, 'deny failed: HTTP 429')).mockResolvedValueOnce(undefined)
    const w = startEvalWorker(deps({ client, gate: async () => ({ supported: new Map(), unsupported: ['is good'], datanetsSearched: [27] }) }))
    await waitFor(() => deny.mock.calls.length >= 2)
    await w.stop()
    expect(deny.mock.calls.length).toBe(2)
    expect(client.failed).toHaveLength(0)
  })
})

// ── H1: the gateway caps a denial reason at 2000 chars (eval-api
//    denyRequestSchema); intake caps the criteria COUNT, not their length ─────

describe('buildDenyReason', () => {
  const long = (i: number) => `criterion ${i}: ` + 'the plan must survive an adverse funding regime for a sustained period '.repeat(4)

  it('stays inside the gateway 2000-char cap with 10 long unsupported criteria, naming each by index', () => {
    const criteria = Array.from({ length: 10 }, (_, i) => long(i + 1))
    const reason = buildDenyReason(criteria, criteria, [27, 31])
    expect(reason.length).toBeLessThanOrEqual(2000)
    for (let i = 1; i <= 10; i++) expect(reason).toContain(`#${i}`)
    expect(reason).toContain('27, 31')
  })

  it('hard-clamps even when the excerpts alone would overflow', () => {
    const criteria = Array.from({ length: 40 }, (_, i) => long(i + 1))
    expect(buildDenyReason(criteria, criteria, [27]).length).toBeLessThanOrEqual(2000)
  })

  it('reads naturally for a normal two-criterion denial (full text, no truncation)', () => {
    const criteria = ['entry historically profitable', 'sizing survives a stop hunt']
    const reason = buildDenyReason([criteria[1]!], criteria, [27])
    expect(reason).toContain('#2 "sizing survives a stop hunt"')
    expect(reason).not.toContain('...')
    expect(reason).toMatch(/searched datanets 27/)
  })
})

describe('startEvalWorker (deny reason bound)', () => {
  it('posts a deny reason the gateway will accept even with 10 long criteria', async () => {
    const criteria = Array.from({ length: 10 }, (_, i) => `criterion ${i + 1}: ` + 'x'.repeat(300))
    const longJob: LeasedJob = { ...job('j-long'), request: { type: 'answer', payload: 'p', criteria } }
    const client = makeClient([longJob, null])
    const w = startEvalWorker(deps({ client, gate: async () => ({ supported: new Map(), unsupported: criteria, datanetsSearched: [27] }) }))
    await waitFor(() => client.denied.length === 1)
    await w.stop()
    const reason = (client.denied[0] as { reason: string }).reason
    expect(reason.length).toBeLessThanOrEqual(2000)
    expect(reason).toContain('#10')
  })
})

// ── M1: a reservation covers LLM spend; a failure BEFORE the first model call
//    must give it back, or an outage drains the day's cap for free ───────────

describe('startEvalWorker (budget release on pre-LLM failures)', () => {
  it('a datanet source error gives the reservation back', async () => {
    const client = makeClient([job('j-src'), null])
    const b = budget(5)
    const w = startEvalWorker(
      deps({
        client,
        budget: b,
        datanet: {
          listAccessible: async () => {
            throw new Error('datanet api HTTP 503')
          },
          fetchPods: async () => [],
        },
      }),
    )
    await waitFor(() => client.failed.length === 1)
    await w.stop()
    expect(b.usedToday()).toBe(0)
  })

  it('no accessible datanets gives the reservation back', async () => {
    const client = makeClient([job('j-none'), null])
    const b = budget(5)
    const w = startEvalWorker(deps({ client, budget: b, datanet: new InMemoryDatanetSource([]) }))
    await waitFor(() => client.failed.length === 1)
    await w.stop()
    expect(b.usedToday()).toBe(0)
  })

  it('a zero-candidate denial gives the reservation back (the gate short-circuits without a model call)', async () => {
    const client = makeClient([job('j-empty'), null])
    const b = budget(5)
    const w = startEvalWorker(
      deps({
        client,
        budget: b,
        gate: async (): Promise<GateResult> => ({ supported: new Map(), unsupported: ['is good'], datanetsSearched: [] }),
        datanet: new InMemoryDatanetSource([{ datanetId: 27, name: 'a', pods: [{ datanetId: 27, podId: '1', name: 'cats', text: 'felines purring' }] }]),
      }),
    )
    await waitFor(() => client.denied.length === 1)
    await w.stop()
    expect(b.usedToday()).toBe(0)
  })

  it('a successful judge keeps the reservation spent', async () => {
    const client = makeClient([job('j-ok'), null])
    const b = budget(5)
    const w = startEvalWorker(deps({ client, budget: b }))
    await waitFor(() => client.completed.length === 1)
    await w.stop()
    expect(b.usedToday()).toBe(1)
  })

  it('a judge failure AFTER the gate call keeps the reservation spent', async () => {
    const client = makeClient([job('j-judge'), null])
    const b = budget(5)
    const w = startEvalWorker(
      deps({
        client,
        budget: b,
        judge: async () => {
          throw new Error('model exploded')
        },
      }),
    )
    await waitFor(() => client.failed.length === 1)
    await w.stop()
    expect(b.usedToday()).toBe(1)
  })

  it('a denial after a real gate call (candidates present) keeps the reservation spent', async () => {
    const client = makeClient([job('j-deny'), null])
    const b = budget(5)
    const w = startEvalWorker(
      deps({ client, budget: b, gate: async () => ({ supported: new Map(), unsupported: ['is good'], datanetsSearched: [27] }) }),
    )
    await waitFor(() => client.denied.length === 1)
    await w.stop()
    expect(b.usedToday()).toBe(1)
  })
})
