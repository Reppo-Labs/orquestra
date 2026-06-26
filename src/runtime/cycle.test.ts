// src/runtime/cycle.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCycle, type CycleDeps } from './cycle.js'
import { StrategyConfigSchema } from '../config/schema.js'
import type { DatanetRubric } from '../rubric/types.js'
import type { DatanetAdapter } from '../adapter/types.js'
import type { LockArgs } from '../reppo/cli.js'
import { markStakeTargetAttempted } from '../wallet/stakeTopUp.js'

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
    voteScorerFor: () => ({ scorer: { scorePod: async () => ({ score: 9, reason: 'good' }) } }),
    candidateScorer: { scoreCandidate: async () => ({ score: 9, reason: 'good' }) },
    seenKeysFor: async () => new Set<string>(),
    getVeReppo: async () => 0,
    executor: {
      executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xvote' })),
      executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xmint' })),
    } as unknown as CycleDeps['executor'],
    ledger: { startCycle: vi.fn(), canVote: () => true, canMint: () => true, votesRemaining: () => 99 } as unknown as CycleDeps['ledger'],
    recordVote: vi.fn(),
    recordMint: vi.fn(),
    getEmissionsDue: async () => [],
    seenClaims: async () => new Set<string>(),
    recordActivity: vi.fn(),
    recordClaim: vi.fn(),
    ...over,
  }
}

describe('runCycle video-pod skips', () => {
  it('records a per-pod skip activity entry when a video pod scoring throws (idle datanet explains itself)', async () => {
    const recordActivity = vi.fn()
    const d = deps({
      recordActivity,
      // Single vote-only datanet; its only pod throws (e.g. a video ingest skip).
      voteScorerFor: () => ({ scorer: { scorePod: async () => { throw new Error('Gemini Files API file never reached ACTIVE (state FAILED)') } } }),
    })
    const cfg = StrategyConfigSchema.parse({
      horizonDays: 30, cadenceHours: 6,
      stake: { lockReppo: 0, lockDurationDays: 30 },
      budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 1000, mintGasEthMax: 1, claimGasEthMax: 1 },
      datanets: { '2': { vote: true, mint: false, strictness: 'aggressive' } },
    })
    await runCycle(cfg, 'cyc-skip', d)
    const skip = (recordActivity as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as { kind: string; reason?: string; podId?: string })
      .find((e) => e.kind === 'skip' && /pod scoring skipped/.test(e.reason ?? ''))
    expect(skip).toBeDefined()
    expect(skip!.podId).toBe('p1')
    expect(skip!.reason).toContain('never reached ACTIVE')
  })

  it('arms the per-cycle video budget once via resetVideoBudget', async () => {
    const resetVideoBudget = vi.fn()
    const d = deps({ resetVideoBudget })
    await runCycle(config, 'cyc-reset', d)
    expect(resetVideoBudget).toHaveBeenCalledTimes(1)
  })
})

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

  it('splits the per-cycle vote cap across datanets by voteShare (3:1)', async () => {
    const pods = (n: number) => Array.from({ length: n }, (_, i) => ({ podId: `p${i}`, validityEpoch: '100', name: `pod${i}`, description: 'd' }))
    let cast = 0
    const CAP = 8
    const cfg = StrategyConfigSchema.parse({
      horizonDays: 30, cadenceHours: 6, stake: { lockReppo: 0, lockDurationDays: 30 },
      budget: { voteGasEthMax: 1, voteRateMaxPerCycle: CAP, mintReppoMax: 1000, mintGasEthMax: 1, claimGasEthMax: 1 },
      datanets: { '9': { vote: true, mint: false, strictness: 'aggressive', voteShare: 3 }, '2': { vote: true, mint: false, strictness: 'aggressive', voteShare: 1 } },
    })
    const executeVote = vi.fn(async () => { cast++; return { ok: true, status: 'executed', txHash: '0xv' } })
    const d = deps({
      getPodsAndFilter: vi.fn(async () => ({ pods: pods(10), filter: { currentEpoch: '100', ownPodIds: [], votedPodIds: [] } })),
      executor: { executeVote, executeMint: vi.fn() } as unknown as CycleDeps['executor'],
      ledger: { startCycle: vi.fn(), canVote: () => cast < CAP, canMint: () => false, votesRemaining: () => Math.max(0, CAP - cast) } as unknown as CycleDeps['ledger'],
    })
    await runCycle(cfg, 'cyc-share', d)
    const calls = (executeVote as any).mock.calls.map((c: any[]) => c[0].datanetId as string)
    expect(calls.filter((id: string) => id === '9').length).toBe(6)
    expect(calls.filter((id: string) => id === '2').length).toBe(2)
    expect(cast).toBe(CAP)
  })

  it('redistributes a datanet\'s unused slots to a datanet that still has pods', async () => {
    const pods = (n: number) => Array.from({ length: n }, (_, i) => ({ podId: `p${i}`, validityEpoch: '100', name: `pod${i}`, description: 'd' }))
    let cast = 0
    const CAP = 8
    const cfg = StrategyConfigSchema.parse({
      horizonDays: 30, cadenceHours: 6, stake: { lockReppo: 0, lockDurationDays: 30 },
      budget: { voteGasEthMax: 1, voteRateMaxPerCycle: CAP, mintReppoMax: 1000, mintGasEthMax: 1, claimGasEthMax: 1 },
      datanets: { '9': { vote: true, mint: false, strictness: 'aggressive', voteShare: 3 }, '2': { vote: true, mint: false, strictness: 'aggressive', voteShare: 1 } },
    })
    const executeVote = vi.fn(async () => { cast++; return { ok: true, status: 'executed', txHash: '0xv' } })
    const d = deps({
      // '9' has plenty of pods; '2' has only 1 (uses 1 of its 2 slots → 1 leftover redistributes to '9').
      getPodsAndFilter: vi.fn(async (id: string) => ({ pods: id === '2' ? pods(1) : pods(10), filter: { currentEpoch: '100', ownPodIds: [], votedPodIds: [] } })),
      executor: { executeVote, executeMint: vi.fn() } as unknown as CycleDeps['executor'],
      ledger: { startCycle: vi.fn(), canVote: () => cast < CAP, canMint: () => false, votesRemaining: () => Math.max(0, CAP - cast) } as unknown as CycleDeps['ledger'],
    })
    await runCycle(cfg, 'cyc-redist', d)
    const calls = (executeVote as any).mock.calls.map((c: any[]) => c[0].datanetId as string)
    expect(calls.filter((id: string) => id === '2').length).toBe(1)   // only 1 pod available
    expect(calls.filter((id: string) => id === '9').length).toBe(7)   // 6 share + 1 redistributed
    expect(cast).toBe(CAP)
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
    // grant-access is keyed by datanet id; datanets 9 and 2 are distinct → one grant each.
    // Both are REPPO-fee datanets (no accessFeeToken) → the 'reppo' token path.
    expect(executeGrantAccess).toHaveBeenCalledWith('9', 'reppo')
    expect(executeGrantAccess).toHaveBeenCalledWith('2', 'reppo')
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

  // --- observability: a structurally-incapable datanet must explain WHY it is idle ---
  const skipReasons = (rec: ReturnType<typeof vi.fn>): string[] =>
    rec.mock.calls.map((c) => c[0]).filter((e) => e.kind === 'skip').map((e) => e.reason as string)

  it('records a skip reason when vote is enabled but the datanet has no voter rubric', async () => {
    const d = deps({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, canVote: false })) })
    await runCycle(config, 'c-novote', d)
    expect(skipReasons(d.recordActivity as any).some((r) => /no on-chain voter rubric/.test(r))).toBe(true)
  })

  it('records a skip reason when mint is enabled but the datanet has no publisher spec', async () => {
    const cfg = StrategyConfigSchema.parse({
      ...config,
      datanets: { '9': { vote: false, mint: true, strictness: 'aggressive', adapter: 'hyperliquid' } },
    })
    const d = deps({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, canMint: false })) })
    await runCycle(cfg, 'c-nomint', d)
    expect(skipReasons(d.recordActivity as any).some((r) => /no on-chain publisher spec/.test(r))).toBe(true)
  })

  it('skips vote scoring entirely when the per-cycle vote budget is already exhausted', async () => {
    const scorePod = vi.fn(async () => ({ score: 9, reason: 'good' }))
    const d = deps({
      voteScorerFor: () => ({ scorer: { scorePod } }),
      ledger: { startCycle: vi.fn(), canVote: () => false, canMint: () => true } as unknown as CycleDeps['ledger'],
    })
    await runCycle(config, 'c-novotebudget', d)
    expect(scorePod).not.toHaveBeenCalled() // no wasted LLM spend
    expect((d.executor.executeVote as any).mock.calls.length).toBe(0)
    // but the dashboard still learns why the datanet is idle
    expect(skipReasons(d.recordActivity as any).some((r) => /vote budget\/rate exhausted/.test(r))).toBe(true)
  })

  it('skips mint discovery when the mint budget is exhausted (no wasted adapter/LLM work)', async () => {
    const discover = vi.fn(async () => [{ canonicalKey: 'k1', podName: 'p', podDescription: 'd', dataset: {} }])
    const d = deps({
      getAdapter: () => ({ id: 'hyperliquid', matches: () => true, discover }),
      ledger: { startCycle: vi.fn(), canVote: () => true, canMint: () => false } as unknown as CycleDeps['ledger'],
    })
    await runCycle(config, 'c-nomintbudget', d)
    expect(discover).not.toHaveBeenCalled()
    expect((d.executor.executeMint as any).mock.calls.length).toBe(0)
  })

  // Note: datanet 9 votes in `config`, so the mint-budget skip activity entry is
  // suppressed for it (idleThisCycle false) — covered by the idle-suppression test above.

  it('does NOT write a mint-incapability skip entry for a datanet that voted this cycle (keeps dashboard idle correct)', async () => {
    // vote:true + mint:true, canVote true but canMint false: it votes, so it is NOT idle.
    const d = deps({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, canVote: true, canMint: false })) })
    await runCycle(config, 'c-voted-nomint', d)
    // votes happened (datanet 9 + 2 both vote), so no publisher-spec skip should be persisted
    expect(skipReasons(d.recordActivity as any).some((r) => /no on-chain publisher spec/.test(r))).toBe(false)
    expect((d.executor.executeVote as any).mock.calls.length).toBeGreaterThan(0)
  })

  it('records a skip reason when the configured adapter id is not registered', async () => {
    const cfg = StrategyConfigSchema.parse({
      ...config,
      datanets: { '9': { vote: false, mint: true, strictness: 'aggressive', adapter: 'typo-adapter' } },
    })
    const d = deps()
    await runCycle(cfg, 'c-badadapter', d)
    expect((d.executor.executeMint as any).mock.calls.length).toBe(0)
    expect(skipReasons(d.recordActivity as any).some((r) => /adapter "typo-adapter" is not registered/.test(r))).toBe(true)
  })

  it('records a skip reason when candidates are discovered but none pass scoring/dedup', async () => {
    // mint-only datanet (vote:false) so it is idle this cycle and the skip is surfaced.
    const cfg = StrategyConfigSchema.parse({
      ...config,
      datanets: { '9': { vote: false, mint: true, strictness: 'aggressive', adapter: 'hyperliquid' } },
    })
    const d = deps({ candidateScorer: { scoreCandidate: async () => ({ score: 1, reason: 'weak' }) } }) // below aggressive like-threshold
    await runCycle(cfg, 'c-allrejected', d)
    expect((d.executor.executeMint as any).mock.calls.length).toBe(0)
    expect(skipReasons(d.recordActivity as any).some((r) => /discovered but none passed scoring\/dedup/.test(r))).toBe(true)
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

  it('calls registerVoteOnPlatform with (podId, txHash) on an executed vote', async () => {
    const registerVoteOnPlatform = vi.fn(async () => {})
    const d = deps({ registerVoteOnPlatform })
    await runCycle(config, 'c-plat', d)
    // default executeVote returns txHash:'0xvote'; datanets 9 and 2 both vote on pod p1
    expect(registerVoteOnPlatform).toHaveBeenCalledWith('p1', '0xvote')
    expect(registerVoteOnPlatform).toHaveBeenCalledTimes(2) // once per vote-enabled datanet
  })

  it('does not call registerVoteOnPlatform when txHash is absent', async () => {
    const registerVoteOnPlatform = vi.fn(async () => {})
    const d = deps({
      registerVoteOnPlatform,
      executor: {
        executeVote: vi.fn(async () => ({ ok: true as const, status: 'executed' as const })), // no txHash
        executeMint: vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xm' })),
      } as unknown as CycleDeps['executor'],
    })
    await runCycle(config, 'c-plat-notx', d)
    expect(registerVoteOnPlatform).not.toHaveBeenCalled()
  })

  it('does not call registerVoteOnPlatform on non-executed vote status', async () => {
    const registerVoteOnPlatform = vi.fn(async () => {})
    const d = deps({
      registerVoteOnPlatform,
      executor: {
        executeVote: vi.fn(async () => ({ ok: false as const, status: 'error' as const, txHash: '0xerr', detail: 'fail' })),
        executeMint: vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xm' })),
      } as unknown as CycleDeps['executor'],
    })
    await runCycle(config, 'c-plat-err', d)
    expect(registerVoteOnPlatform).not.toHaveBeenCalled()
  })

  it('a rejected registerVoteOnPlatform never aborts the cycle', async () => {
    const d = deps({ registerVoteOnPlatform: vi.fn(async () => { throw new Error('api down') }) })
    await expect(runCycle(config, 'c-plat-fail', d)).resolves.toBeDefined()
    await Promise.resolve() // flush fire-and-forget .catch handler
  })

  it('skips vote AND mint when subnet access is required and the grant fails (no scoring waste)', async () => {
    const executeGrantAccess = vi.fn(async () => ({
      ok: false as const, status: 'error' as const,
      detail: 'grant-access failed: INSUFFICIENT_REPPO_BALANCE',
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
    expect(skips[0].reason).toMatch(/grant-access error/)
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

  // --- non-REPPO access fee: capability gate ---
  // 50 EXY @ 6 dp → raw 50_000_000. amountRaw is what the raw-to-raw balance gate compares.
  const exyToken = { address: '0xExy0000000000000000000000000000000000001', symbol: 'EXY', decimals: 6, amount: 50, amountRaw: '50000000' }
  const nonReppoConfig = StrategyConfigSchema.parse({
    horizonDays: 30, cadenceHours: 6,
    stake: { lockReppo: 0, lockDurationDays: 30 },
    budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 1000, mintGasEthMax: 1, claimGasEthMax: 1 },
    datanets: { '42': { vote: true, mint: false, strictness: 'aggressive' } },
  })

  it('skips a non-REPPO-fee datanet with a recorded reason when the CLI cannot pay primary (capability OFF)', async () => {
    const executeGrantAccess = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xg' }))
    const d = deps({
      getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: 'cm-42', economics: { accessFeeReppo: 0, accessFeeToken: exyToken, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' } })),
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      grantedSubnets: async () => new Set<string>(),
      recordGrant: vi.fn(),
      supportsNonReppoGrants: false,
    })
    const report = await runCycle(nonReppoConfig, 'c-nonreppo-off', d)
    expect(executeGrantAccess).not.toHaveBeenCalled() // never fires an unsupported flag
    expect(d.getPodsAndFilter).not.toHaveBeenCalled() // skipped before scoring
    const d42 = report.datanets.find((r) => r.datanetId === '42')!
    expect(d42.skipped).toMatch(/non-REPPO access fee needs reppo CLI ≥ 0\.8\.5/)
    expect(skipReasons(d.recordActivity as any).some((r) => /non-REPPO access fee needs reppo CLI ≥ 0\.8\.5/.test(r))).toBe(true)
  })

  it('grants a non-REPPO-fee datanet with token=primary when the CLI supports it (capability ON)', async () => {
    const executeGrantAccess = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xg' }))
    const d = deps({
      getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: 'cm-42', economics: { accessFeeReppo: 0, accessFeeToken: exyToken, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' } })),
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      grantedSubnets: async () => new Set<string>(),
      recordGrant: vi.fn(),
      supportsNonReppoGrants: true,
    })
    const report = await runCycle(nonReppoConfig, 'c-nonreppo-on', d)
    expect(executeGrantAccess).toHaveBeenCalledWith('42', 'primary')
    expect(report.datanets.find((r) => r.datanetId === '42')!.skipped).toBeUndefined()
  })

  it('skips a non-REPPO datanet when the wallet balance is below the access fee (decimals-aware)', async () => {
    const executeGrantAccess = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xg' }))
    // EXY has 6 decimals; need 50 EXY = 50_000_000 raw. Wallet holds 49 EXY = 49_000_000 raw.
    const readTokenBalance = vi.fn(async () => 49_000_000n)
    const d = deps({
      getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: 'cm-42', economics: { accessFeeReppo: 0, accessFeeToken: exyToken, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' } })),
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      grantedSubnets: async () => new Set<string>(),
      recordGrant: vi.fn(),
      supportsNonReppoGrants: true,
      readTokenBalance,
      walletAddress: '0xWallet',
    })
    const report = await runCycle(nonReppoConfig, 'c-insufficient', d)
    expect(readTokenBalance).toHaveBeenCalledWith(exyToken.address, '0xWallet')
    expect(executeGrantAccess).not.toHaveBeenCalled()       // never paid — pre-check stopped it
    expect(d.getPodsAndFilter).not.toHaveBeenCalled()       // skipped before scoring
    const d42 = report.datanets.find((r) => r.datanetId === '42')!
    expect(d42.skipped).toMatch(/insufficient EXY balance for access fee/)
    expect(skipReasons(d.recordActivity as any).some((r) => /insufficient EXY balance/.test(r))).toBe(true)
  })

  it('grants a non-REPPO datanet with token=primary when the balance covers the fee', async () => {
    const executeGrantAccess = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xg' }))
    const readTokenBalance = vi.fn(async () => 50_000_000n) // exactly 50 EXY @ 6 dp — enough
    const d = deps({
      getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: 'cm-42', economics: { accessFeeReppo: 0, accessFeeToken: exyToken, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' } })),
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      grantedSubnets: async () => new Set<string>(),
      recordGrant: vi.fn(),
      supportsNonReppoGrants: true,
      readTokenBalance,
      walletAddress: '0xWallet',
    })
    const report = await runCycle(nonReppoConfig, 'c-sufficient', d)
    expect(executeGrantAccess).toHaveBeenCalledWith('42', 'primary')
    expect(report.datanets.find((r) => r.datanetId === '42')!.skipped).toBeUndefined()
  })

  it('does NOT block the grant when no balance reader is wired (CLI still fails closed)', async () => {
    const executeGrantAccess = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xg' }))
    const d = deps({
      getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: 'cm-42', economics: { accessFeeReppo: 0, accessFeeToken: exyToken, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' } })),
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      grantedSubnets: async () => new Set<string>(),
      recordGrant: vi.fn(),
      supportsNonReppoGrants: true,
      // readTokenBalance + walletAddress intentionally omitted (no RPC configured)
    })
    await runCycle(nonReppoConfig, 'c-noreader', d)
    expect(executeGrantAccess).toHaveBeenCalledWith('42', 'primary') // grant still attempted
  })

  it('records a grant breadcrumb (kind:grant) with the fee paid on a successful non-REPPO grant', async () => {
    const executeGrantAccess = vi.fn(async () => ({
      ok: true as const, status: 'executed' as const, txHash: '0xg',
      // feeAmount is the on-chain quote as a STRING (cli keeps it formatted, never Number()s it).
      feeAmount: '50', feeToken: { symbol: 'EXY', address: exyToken.address, decimals: 6 },
    }))
    const d = deps({
      getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: 'cm-42', economics: { accessFeeReppo: 0, accessFeeToken: exyToken, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' } })),
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      grantedSubnets: async () => new Set<string>(),
      recordGrant: vi.fn(),
      supportsNonReppoGrants: true,
      readTokenBalance: vi.fn(async () => 100_000_000n),
      walletAddress: '0xWallet',
    })
    await runCycle(nonReppoConfig, 'c-grantfee', d)
    const grants = (d.recordActivity as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0] as { kind: string; reason?: string; status: string })
      .filter((e) => e.kind === 'grant')
    expect(grants).toHaveLength(1)
    expect(grants[0].status).toBe('executed')
    expect(grants[0].reason).toMatch(/granted access — paid 50 EXY/)
  })

  it('uses token=reppo for a REPPO-fee datanet regardless of the non-REPPO capability flag', async () => {
    const executeGrantAccess = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xg' }))
    const d = deps({
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      grantedSubnets: async () => new Set<string>(),
      recordGrant: vi.fn(),
      supportsNonReppoGrants: false, // off — must not affect the REPPO path
    })
    await runCycle(config, 'c-reppo-path', d)
    expect(executeGrantAccess).toHaveBeenCalledWith('9', 'reppo')
    expect(executeGrantAccess).toHaveBeenCalledWith('2', 'reppo')
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

  it('defers pods beyond the per-cycle budget with ONE deferral note (not a refused row per pod)', async () => {
    const activity: any[] = []
    let cast = 0
    const CAP = 1 // only one vote fits this cycle
    const single = StrategyConfigSchema.parse({
      horizonDays: 30, cadenceHours: 6,
      stake: { lockReppo: 0, lockDurationDays: 30 },
      budget: { voteRateMaxPerCycle: CAP, mintReppoMax: 1000 },
      datanets: { '9': { vote: true, mint: false, strictness: 'aggressive' } },
    })
    const d = deps({
      getPodsAndFilter: vi.fn(async () => ({
        pods: [
          { podId: 'a', validityEpoch: '100', name: 'A', description: 'd' },
          { podId: 'b', validityEpoch: '100', name: 'B', description: 'd' },
          { podId: 'c', validityEpoch: '100', name: 'C', description: 'd' },
        ],
        filter: { currentEpoch: '100', ownPodIds: [], votedPodIds: [] },
      })),
      executor: { executeVote: vi.fn(async () => { cast++; return { ok: true, status: 'executed', txHash: '0xv' } }), executeMint: vi.fn() } as unknown as CycleDeps['executor'],
      ledger: { startCycle: vi.fn(), canVote: () => cast < CAP, canMint: () => false, votesRemaining: () => Math.max(0, CAP - cast) } as unknown as CycleDeps['ledger'],
      recordActivity: (e) => { activity.push(e) },
    })
    await runCycle(single, 'c-defer', d)
    expect((d.executor.executeVote as any).mock.calls.length).toBe(1) // only the one that fits is attempted; the rest are not
    expect(activity.filter((e) => e.kind === 'vote')).toHaveLength(1)  // exactly one vote row (the executed one), no per-pod deferred rows
    const skips = activity.filter((e) => e.kind === 'skip')
    expect(skips).toHaveLength(1)
    expect(skips[0].reason).toMatch(/2 votes deferred to next cycle/)
    expect(d.recordVote).toHaveBeenCalledTimes(1)
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

  it('claims VOTER emissions via executeVoterClaim with a voter-prefixed dedup key', async () => {
    const recorded: string[] = []
    const executeVoterClaim = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xvc', gasEth: 0.0009, reppoClaimed: 7 }))
    const executor = {
      executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
      executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
      executeClaim: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xc', gasEth: 0 })),
      executeVoterClaim,
    } as unknown as CycleDeps['executor']
    const d = deps({
      getEmissionsDue: async () => [],                       // no owner claims
      getVoterEmissionsDue: async () => [{ podId: '1624', datanetId: '11', epoch: 105, reppo: 0 }],
      seenClaims: async () => new Set<string>(),
      executor,
      recordClaim: vi.fn((key: string) => { recorded.push(key) }),
    })
    const report = await runCycle(config, 'c-voter', d)
    expect(executeVoterClaim).toHaveBeenCalledTimes(1)
    expect(report.claims).toHaveLength(1)
    expect(recorded).toEqual(['voter-1624:105'])            // voter-prefixed — no collision with owner key
    const activity = (d.recordActivity as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0] as { kind: string; podId?: string; reppoClaimed?: number; detail?: string })
    const row = activity.find((e) => e.kind === 'claim' && e.podId === '1624')
    expect(row?.reppoClaimed).toBe(7)
    expect(row?.detail).toContain('voter')
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

describe('runCycle stake top-up', () => {
  // The once-per-target guard (the shared latch in stakeTopUp.ts) is module-level per-process,
  // so it persists across tests in this file. Use DISTINCT targets per test so cross-test state
  // doesn't interfere (2000, 1700, 1500, 1300, 2222).
  const stakeExecutor = (lock: CycleDeps['executor']['lock']): CycleDeps['executor'] => ({
    executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
    executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
    lock,
  }) as unknown as CycleDeps['executor']
  const cfgStake = (lockReppo: number, lockDurationDays = 30) =>
    StrategyConfigSchema.parse({ ...config, stake: { lockReppo, lockDurationDays } })

  it('locks the difference when veREPPO is below the config target, once per target', async () => {
    const lock = vi.fn(async (_args: LockArgs) => ({ ok: true as const, status: 'executed' as const, txHash: '0xlock' }))
    const d = deps({ getVeReppo: async () => 1031, executor: stakeExecutor(lock) })
    const cfg = cfgStake(2000)
    await runCycle(cfg, 'c1', d)
    await runCycle(cfg, 'c2', d) // same target → no second lock (guard)
    expect(lock).toHaveBeenCalledTimes(1)
    expect(lock.mock.calls[0][0]).toMatchObject({ amountReppo: 969, durationSeconds: 30 * 86400 })
  })

  it('does not lock when veREPPO is at/above target', async () => {
    const lock = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xlock' }))
    const d = deps({ getVeReppo: async () => 1700, executor: stakeExecutor(lock) })
    await runCycle(cfgStake(1700), 'c-ata', d)
    expect(lock).not.toHaveBeenCalled()
  })

  it('a lock failure does not abort the cycle', async () => {
    const lock = vi.fn(async () => { throw new Error('INSUFFICIENT_REPPO_BALANCE') })
    const d = deps({ getVeReppo: async () => 0, executor: stakeExecutor(lock) })
    const r = await runCycle(cfgStake(1500), 'c-fail', d)
    expect(r).toBeDefined() // cycle completed despite the lock throwing
  })

  it('SKIPS the top-up on a failed balance read (never locks the full target)', async () => {
    const lock = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xlock' }))
    // null = read failure. Must NOT be treated as 0 (which would lock the full target).
    const d = deps({ getVeReppo: async () => null, executor: stakeExecutor(lock) })
    await runCycle(cfgStake(1300), 'c-readfail', d)
    expect(lock).not.toHaveBeenCalled()
  })

  it('retries a FAILED lock on the next cycle (latch only on success, never on failure)', async () => {
    let attempt = 0
    const lock = vi.fn(async () => {
      attempt++
      return attempt === 1
        ? { ok: false as const, status: 'error' as const, detail: 'INSUFFICIENT_REPPO_BALANCE' }
        : { ok: true as const, status: 'executed' as const, txHash: '0xlock' }
    })
    const d = deps({ getVeReppo: async () => 0, executor: stakeExecutor(lock) })
    const cfg = cfgStake(1800)
    await runCycle(cfg, 'c1', d) // attempt 1 fails — must NOT latch
    await runCycle(cfg, 'c2', d) // attempt 2 retries and succeeds
    expect(lock).toHaveBeenCalledTimes(2)
  })

  it('records the lock-failure reason in the stake activity so the operator sees WHY', async () => {
    const acts: any[] = []
    const lock = vi.fn(async () => ({ ok: false as const, status: 'error' as const, detail: 'INSUFFICIENT_REPPO_BALANCE' }))
    const d = deps({ getVeReppo: async () => 0, executor: stakeExecutor(lock), recordActivity: (e: any) => acts.push(e) })
    await runCycle(cfgStake(1950), 'c-why', d)
    const stake = acts.find((e) => e.kind === 'stake')
    expect(stake).toBeDefined()
    expect(stake.status).toBe('skipped')
    expect(stake.reason).toContain('INSUFFICIENT_REPPO_BALANCE')
  })

  it('does not re-attempt a target the shared latch already marked (setupNode seed)', async () => {
    const lock = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xlock' }))
    // Simulate setupNode having already attempted this target at startup.
    markStakeTargetAttempted(2222)
    const d = deps({ getVeReppo: async () => 100, executor: stakeExecutor(lock) })
    await runCycle(cfgStake(2222), 'c-seeded', d)
    expect(lock).not.toHaveBeenCalled()
  })
})

describe('runCycle per-datanet vote scorer', () => {
  const skipReasons = (rec: ReturnType<typeof vi.fn>): string[] =>
    rec.mock.calls.map((c) => c[0]).filter((e) => e.kind === 'skip').map((e) => e.reason as string)

  it('votes when voteScorerFor returns a scorer', async () => {
    const d = deps()
    const report = await runCycle(config, 'c-vote', d)
    const d9 = report.datanets.find((r) => r.datanetId === '9')!
    expect(d9.votes).toHaveLength(1)
    expect((d.executor.executeVote as any).mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('records a skip and casts no vote when voteScorerFor returns { skip }', async () => {
    const d = deps({ voteScorerFor: () => ({ skip: 'no API key for google' }) })
    const report = await runCycle(config, 'c-skip', d)
    for (const dn of report.datanets) expect(dn.votes).toHaveLength(0)
    expect((d.executor.executeVote as any).mock.calls.length).toBe(0)
    expect(skipReasons(d.recordActivity as any).some((r) => /no API key for google/.test(r))).toBe(true)
  })
})
