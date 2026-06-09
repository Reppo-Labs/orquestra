// src/runtime/cycle.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCycle, type CycleDeps } from './cycle.js'
import { StrategyConfigSchema } from '../config/schema.js'
import type { DatanetRubric } from '../rubric/types.js'
import type { DatanetAdapter } from '../adapter/types.js'

const rubric = (over: Partial<DatanetRubric> = {}): DatanetRubric => ({
  datanetId: '9', name: 'TradingGym AI', goal: 'g', publisherSpec: 'p', voterRubric: 'v',
  canVote: true, canMint: true, status: 'ACTIVE', subnetUuid: 'cm-test-9',
  economics: { accessFeeReppo: 0, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'REPPO' },
  ...over,
})

const config = StrategyConfigSchema.parse({
  horizonDays: 30, cadenceHours: 6,
  stake: { lockReppo: 0, lockDurationDays: 30 },
  budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 1000, mintGasEthMax: 1, claimGasEthMax: 1 },
  datanets: {
    '9': { vote: true, mint: true, strictness: 'aggressive', adapter: 'hyperliquid' },
    '2': { vote: true, mint: false, strictness: 'aggressive' },
  },
})

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-cyc-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function deps(over: Partial<CycleDeps> = {}): CycleDeps {
  const adapter: DatanetAdapter = {
    id: 'hyperliquid', matches: () => true,
    discover: vi.fn(async () => [{ canonicalKey: 'k1', podName: 'HL perps', podDescription: 'd', dataset: { a: 1 } }]),
  }
  return {
    dataDir: dir, topN: 5,
    getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, name: id === '2' ? 'Geo' : 'TradingGym AI' })),
    getPodsAndFilter: vi.fn(async (_id: string) => ({
      pods: [{ podId: 'p1', validityEpoch: '100', name: 'pod', description: 'd' }],
      filter: { currentEpoch: '100', ownPodIds: [], votedPodIds: [] },
    })),
    getAdapter: (adapterId: string) => (adapterId === 'hyperliquid' ? adapter : undefined),
    voteScorer: { scorePod: async () => ({ score: 9, reason: 'good' }) },
    candidateScorer: { scoreCandidate: async () => ({ score: 9, reason: 'good' }) },
    seenKeysFor: async () => new Set<string>(),
    executor: {
      executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xvote' })),
      executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xmint' })),
    } as unknown as CycleDeps['executor'],
    ledger: { startCycle: vi.fn() } as unknown as CycleDeps['ledger'],
    recordVote: vi.fn(),
    recordMint: vi.fn(),
    getEmissionsDue: async () => [],
    seenClaims: async () => new Set<string>(),
    recordActivity: vi.fn(),
    recordClaim: vi.fn(),
    ...over,
  }
}

describe('runCycle', () => {
  it('starts the cycle, votes on every vote-enabled datanet, mints only where adapter+canMint', async () => {
    const d = deps()
    const report = await runCycle(config, 'cycle-1', d)
    expect(d.ledger.startCycle).toHaveBeenCalledWith('cycle-1')
    expect((d.executor.executeVote as any).mock.calls.length).toBe(2)
    expect((d.executor.executeMint as any).mock.calls.length).toBe(1)
    const d9 = report.datanets.find((r) => r.datanetId === '9')!
    expect(d9.votes[0].txHash).toBe('0xvote')
    expect(d9.mints[0].txHash).toBe('0xmint')
    expect(report.datanets.find((r) => r.datanetId === '2')!.mints).toEqual([])
  })

  it('grants subnet access once before voting/minting and caches it (no re-grant for a shared subnet)', async () => {
    const granted = new Set<string>()
    const executeGrantAccess = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xgrant' }))
    const d = deps({
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      grantedSubnets: async () => granted,
      recordGrant: (id: string) => { granted.add(id) },
    })
    await runCycle(config, 'cycle-grant', d)
    // grant-access is keyed by datanet id; datanets 9 and 2 are distinct → one grant each
    expect(executeGrantAccess).toHaveBeenCalledWith('9')
    expect(executeGrantAccess).toHaveBeenCalledWith('2')
    expect(executeGrantAccess).toHaveBeenCalledTimes(2)
    expect(granted.has('9') && granted.has('2')).toBe(true)
  })

  it('skips grant when the subnet is already granted', async () => {
    const executeGrantAccess = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xgrant' }))
    const d = deps({
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      grantedSubnets: async () => new Set(['9', '2']),
      recordGrant: vi.fn(),
    })
    await runCycle(config, 'cycle-grant2', d)
    expect(executeGrantAccess).not.toHaveBeenCalled()
  })

  it('skips voting when rubric.canVote is false and minting when canMint is false', async () => {
    const d = deps({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, canVote: false, canMint: false })) })
    const report = await runCycle(config, 'c2', d)
    expect((d.executor.executeVote as any).mock.calls.length).toBe(0)
    expect((d.executor.executeMint as any).mock.calls.length).toBe(0)
    expect(report.datanets.every((r) => r.votes.length === 0 && r.mints.length === 0)).toBe(true)
  })

  it('does not mint a datanet with mint:true but no adapter configured', async () => {
    const cfg = StrategyConfigSchema.parse({
      ...config,
      datanets: { '5': { vote: false, mint: true, strictness: 'aggressive' } },
    })
    const d = deps()
    await runCycle(cfg, 'c3', d)
    expect((d.executor.executeMint as any).mock.calls.length).toBe(0)
  })

  it('isolates a per-datanet failure: a throwing getRubric skips that datanet, others proceed', async () => {
    const d = deps({
      getRubric: vi.fn(async (id: string) => {
        if (id === '2') throw new Error('RPC rate limit')
        return rubric({ datanetId: id })
      }),
    })
    const report = await runCycle(config, 'c4', d) // must NOT reject
    const d2 = report.datanets.find((r) => r.datanetId === '2')!
    expect(d2.error).toMatch(/RPC rate limit/)
    expect(d2.votes).toEqual([])
    const d9 = report.datanets.find((r) => r.datanetId === '9')!
    expect(d9.votes.length).toBeGreaterThan(0) // datanet 9 still processed
  })

  it('records confirmed vote and mint via recordVote/recordMint on r.ok', async () => {
    const d = deps()
    await runCycle(config, 'c5', d)
    // datanet 9 has vote:true + mint:true + adapter → both should be recorded
    expect(d.recordVote).toHaveBeenCalledWith('9', 'p1')
    expect(d.recordMint).toHaveBeenCalledWith('9', 'k1')
    // datanet 2 has vote:true, mint:false → vote recorded, no mint call
    expect(d.recordVote).toHaveBeenCalledWith('2', 'p1')
    expect((d.recordMint as ReturnType<typeof vi.fn>).mock.calls.filter((c: string[]) => c[0] === '2')).toEqual([])
  })

  it('skips vote AND mint when subnet access is required and the grant is refused (no scoring waste)', async () => {
    const executeGrantAccess = vi.fn(async () => ({
      ok: false as const, status: 'refused-budget' as const,
      detail: 'grant REPPO budget exhausted (set budget.grantReppoMax to enable subnet-access grants)',
    }))
    const d = deps({
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      grantedSubnets: async () => new Set<string>(),
      recordGrant: vi.fn(),
    })
    const report = await runCycle(config, 'cycle-skip', d)

    // the expensive paths were never entered
    expect(d.getPodsAndFilter).not.toHaveBeenCalled()
    expect((d.executor.executeVote as any).mock.calls.length).toBe(0)
    expect((d.executor.executeMint as any).mock.calls.length).toBe(0)

    // the skip is visible in the report and the activity log
    const d9 = report.datanets.find((r) => r.datanetId === '9')!
    expect(d9.skipped).toMatch(/subnet access not granted/)
    const skips = (d.recordActivity as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0] as { kind: string; datanetId: string; status: string; reason?: string })
      .filter((e) => e.kind === 'skip')
    expect(skips.length).toBe(2) // datanets 9 and 2, one entry each per cycle
    expect(skips[0].status).toBe('skipped')
    expect(skips[0].reason).toMatch(/grant-access refused-budget/)
  })

  it('does not skip when access is already granted, when the grant succeeds, or when the rubric has no subnetUuid', async () => {
    // already granted → proceeds
    const granted = deps({
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess: vi.fn(),
      } as unknown as CycleDeps['executor'],
      grantedSubnets: async () => new Set(['9', '2']),
      recordGrant: vi.fn(),
    })
    let report = await runCycle(config, 'g1', granted)
    expect(report.datanets.every((r) => r.skipped === undefined)).toBe(true)
    expect(granted.getPodsAndFilter).toHaveBeenCalled()

    // grant succeeds this cycle → proceeds immediately
    const grantsNow = deps({
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess: vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xg' })),
      } as unknown as CycleDeps['executor'],
      grantedSubnets: async () => new Set<string>(),
      recordGrant: vi.fn(),
    })
    report = await runCycle(config, 'g2', grantsNow)
    expect(report.datanets.every((r) => r.skipped === undefined)).toBe(true)

    // no subnetUuid (pre-subnet metadata) → gate not applicable, proceeds
    const noSubnet = deps({
      getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: '' })),
      grantedSubnets: async () => new Set<string>(),
      recordGrant: vi.fn(),
    })
    report = await runCycle(config, 'g3', noSubnet)
    expect(report.datanets.every((r) => r.skipped === undefined)).toBe(true)
    expect(noSubnet.getPodsAndFilter).toHaveBeenCalled()
  })

  it('records a skip activity entry when a datanet fails (rubric error) so the dashboard sees it', async () => {
    const d = deps({
      getRubric: vi.fn(async (id: string) => {
        if (id === '2') throw new Error('RPC rate limit')
        return rubric({ datanetId: id })
      }),
    })
    await runCycle(config, 'c-err', d)
    const skips = (d.recordActivity as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0] as { kind: string; datanetId: string; reason?: string })
      .filter((e) => e.kind === 'skip')
    expect(skips).toHaveLength(1)
    expect(skips[0].datanetId).toBe('2')
    expect(skips[0].reason).toMatch(/datanet error: RPC rate limit/)
  })

  it('records a permanently-failing CANNOT_VOTE_FOR_OWN_POD vote as voted (never retried)', async () => {
    const d = deps({
      executor: {
        executeVote: vi.fn(async () => ({ ok: false, status: 'error', detail: 'reppo vote failed — {"error":{"code":"CANNOT_VOTE_FOR_OWN_POD","hint":"Publishers cannot vote on their own pods."}}' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
      } as unknown as CycleDeps['executor'],
    })
    await runCycle(config, 'c-own', d)
    expect(d.recordVote).toHaveBeenCalledWith('9', 'p1') // permanent error → dedup so it stops retrying
  })

  it('evicts the granted-subnet cache when a vote fails VOTER_LACKS_SUBNET_ACCESS despite the cache', async () => {
    const revokeGrant = vi.fn()
    const d = deps({
      executor: {
        executeVote: vi.fn(async () => ({ ok: false, status: 'error', detail: '{"error":{"code":"VOTER_LACKS_SUBNET_ACCESS"}}' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess: vi.fn(),
      } as unknown as CycleDeps['executor'],
      grantedSubnets: async () => new Set(['9', '2']), // cache says granted — stale
      recordGrant: vi.fn(),
      revokeGrant,
    })
    await runCycle(config, 'c-stale', d)
    expect(revokeGrant).toHaveBeenCalledWith('9') // evicted → next cycle re-attempts the grant
    expect(d.recordVote).not.toHaveBeenCalled()   // NOT recorded as voted — retried after re-grant
  })

  it('records dedup ONLY on executed — refused AND errored are not recorded (so retries are not blocked)', async () => {
    const refused = deps({
      executor: { executeVote: vi.fn(async () => ({ ok: false, status: 'refused-budget' })), executeMint: vi.fn(async () => ({ ok: false, status: 'refused-budget' })) } as unknown as CycleDeps['executor'],
    })
    await runCycle(config, 'c6', refused)
    expect(refused.recordVote).not.toHaveBeenCalled()
    expect(refused.recordMint).not.toHaveBeenCalled()

    const errored = deps({
      executor: { executeVote: vi.fn(async () => ({ ok: false, status: 'error', detail: 'no txHash' })), executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })) } as unknown as CycleDeps['executor'],
    })
    await runCycle(config, 'c7', errored)
    expect(errored.recordVote).not.toHaveBeenCalled()        // errored vote NOT recorded → retried next cycle (idempotency key guards double-spend)
    expect(errored.recordMint).toHaveBeenCalledWith('9', 'k1') // executed mint IS recorded
  })
})

const claimExecutor = (executeClaim: CycleDeps['executor']['executeClaim']): CycleDeps['executor'] => ({
  executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
  executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
  executeClaim,
}) as unknown as CycleDeps['executor']

describe('runCycle claim phase', () => {
  it('claims each unclaimed (pod,epoch), skips already-claimed, records activity + claimedKeys', async () => {
    const recorded: string[] = []
    const claimed = new Set<string>(['2:101']) // 2:101 already claimed
    const d = deps({
      getEmissionsDue: async () => [
        { podId: '1', datanetId: '9', epoch: 101, reppo: 12.5 },
        { podId: '2', datanetId: '9', epoch: 101, reppo: 4 },
      ],
      seenClaims: async () => claimed,
      executor: claimExecutor(async () => ({ ok: true, status: 'executed', txHash: '0xc', gasEth: 0.0009 })),
      recordClaim: vi.fn((key: string) => { recorded.push(key) }),
    })
    const report = await runCycle(config, 'c1', d)
    expect(report.claims).toHaveLength(1) // only pod 1 (pod 2 already claimed)
    expect(recorded).toEqual(['1:101'])
    const activity = (d.recordActivity as ReturnType<typeof vi.fn>).mock.calls
    expect(activity.some((c: unknown[]) => {
      const e = c[0] as { kind: string; podId?: string; reppoClaimed?: number }
      return e.kind === 'claim' && e.podId === '1' && e.reppoClaimed === 12.5
    })).toBe(true)
  })

  it('skips the claim phase entirely when claimEmissions is false', async () => {
    let called = 0
    const d = deps({ getEmissionsDue: async () => { called++; return [] } })
    const cfg = StrategyConfigSchema.parse({ ...config, claimEmissions: false })
    const report = await runCycle(cfg, 'c2', d)
    expect(called).toBe(0)
    expect(report.claims).toEqual([])
  })

  it('isolates a single failing claim from the rest', async () => {
    const d = deps({
      getEmissionsDue: async () => [
        { podId: '1', datanetId: '9', epoch: 101, reppo: 5 },
        { podId: '2', datanetId: '9', epoch: 101, reppo: 5 },
      ],
      seenClaims: async () => new Set<string>(),
      executor: claimExecutor(async (i) => i.podId === '1'
        ? Promise.reject(new Error('boom'))
        : { ok: true, status: 'executed', txHash: '0xc', gasEth: 0.0009 }),
    })
    const report = await runCycle(config, 'c3', d)
    expect(report.claims.filter((c) => c.status === 'executed')).toHaveLength(1) // pod 2 still claimed
  })
})
