// src/runtime/cycle.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCycle, type CycleDeps, type OnchainReads, type OnchainWalletReads, type Dedup, type GrantCache, type ActivityStore, type Scorers, type CycleReads, type AdapterHub } from './cycle.js'
import { StrategyConfigSchema } from '../config/schema.js'
import type { DatanetRubric, VoteRubric } from '../rubric/types.js'
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

// Reusable collaborator fakes. `onchain` is present-or-absent AS A UNIT (a node without
// RPC has none); the wallet tier nests inside it the same way.
const walletReads = (over: Partial<OnchainWalletReads> = {}): OnchainWalletReads => ({
  address: '0xWallet',
  readTokenBalance: async () => 0n,
  getVoterEmissionsDue: async () => [],
  ...over,
})
const onchainReads = (over: Partial<OnchainReads> = {}): OnchainReads => ({
  getEpochVoteVolume: async () => ({ epoch: 0, totalRaw: 0n }),
  ...over,
})
// Dedup fake: nothing seen, spies on the record methods. `grants` stays absent unless a
// test exercises the subnet-access gate (absent = gate not applicable, as in production
// wirings without grant support).
const fakeDedup = (over: Partial<Dedup> = {}): Dedup => ({
  seenKeysFor: async () => new Set<string>(),
  recordVote: vi.fn(),
  recordMint: vi.fn(),
  seenClaims: async () => new Set<string>(),
  recordClaim: vi.fn(),
  ...over,
})
const grantCache = (over: Partial<GrantCache> = {}): GrantCache => ({
  granted: async () => new Set<string>(),
  record: vi.fn(),
  revoke: vi.fn(),
  ...over,
})
// ActivityStore fake: a record spy; beginCycle / platform registration only when a test
// exercises them (absent in RPC-less / test wirings, exactly like production).
const fakeActivity = (over: Partial<ActivityStore> = {}): ActivityStore => ({
  record: vi.fn(),
  ...over,
})
// Scorers fake: everything scores 9/'good' unless a test overrides it.
const fakeScorers = (over: Partial<Scorers> = {}): Scorers => ({
  voteScorerFor: () => ({ scorer: { scorePod: async () => ({ score: 9, reason: 'good' }) } }),
  candidateScorer: { scoreCandidate: async () => ({ score: 9, reason: 'good' }) },
  ...over,
})
// CycleReads fake: one scorable pod per datanet, zero veREPPO, nothing claimable.
const fakeReads = (over: Partial<CycleReads> = {}): CycleReads => ({
  getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, name: id === '2' ? 'Geo' : 'TradingGym AI' })),
  getPodsAndFilter: vi.fn(async (_id: string) => ({
    pods: [{ podId: 'p1', validityEpoch: '100', name: 'pod', description: 'd' }],
    filter: { currentEpoch: '100', ownPodIds: [], votedPodIds: [] },
  })),
  getVeReppo: async () => 0,
  getEmissionsDue: async () => [],
  ...over,
})
// AdapterHub fake: no adapters registered unless a test routes one.
const adapterHub = (over: Partial<AdapterHub> = {}): AdapterHub => ({
  get: () => undefined,
  topN: 5,
  strategyFor: () => ({}),
  existingPodNames: async () => [],
  ...over,
})

function deps(over: Partial<CycleDeps> = {}): CycleDeps {
  const adapter: DatanetAdapter = {
    id: 'hyperliquid',
    discover: vi.fn(async () => [{ canonicalKey: 'k1', podName: 'HL perps', podDescription: 'd', dataset: { a: 1 } }]),
  }
  return {
    dataDir: dir,
    reads: fakeReads(),
    adapters: adapterHub({ get: (adapterId: string) => (adapterId === 'hyperliquid' ? adapter : undefined) }),
    scorers: fakeScorers(),
    dedup: fakeDedup(),
    executor: {
      executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xvote' })),
      executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xmint' })),
    } as unknown as CycleDeps['executor'],
    ledger: { startCycle: vi.fn(), canVote: () => true, canMint: () => true, votesRemaining: () => 99 } as unknown as CycleDeps['ledger'],
    activity: fakeActivity(),
    ...over,
  }
}

describe('runCycle video-pod skips', () => {
  it('records a per-pod skip activity entry when a video pod scoring throws (idle datanet explains itself)', async () => {
    const recordActivity = vi.fn()
    const d = deps({
      activity: fakeActivity({ record: recordActivity }),
      // Single vote-only datanet; its only pod throws (e.g. a video ingest skip).
      scorers: fakeScorers({ voteScorerFor: () => ({ scorer: { scorePod: async () => { throw new Error('Gemini Files API file never reached ACTIVE (state FAILED)') } } }) }),
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

  it('arms the per-cycle video budget once via beginCycle', async () => {
    const beginCycle = vi.fn()
    const d = deps({ activity: fakeActivity({ beginCycle }) })
    await runCycle(config, 'cyc-reset', d)
    expect(beginCycle).toHaveBeenCalledTimes(1)
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
      reads: fakeReads({ getPodsAndFilter: vi.fn(async () => ({ pods: pods(10), filter: { currentEpoch: '100', ownPodIds: [], votedPodIds: [] } })) }),
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
      reads: fakeReads({ getPodsAndFilter: vi.fn(async (id: string) => ({ pods: id === '2' ? pods(1) : pods(10), filter: { currentEpoch: '100', ownPodIds: [], votedPodIds: [] } })) }),
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
      dedup: fakeDedup({ grants: grantCache({ granted: async () => granted, record: (id: string) => { granted.add(id) } }) }),
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
      dedup: fakeDedup({ grants: grantCache({ granted: async () => new Set(['9', '2']) }) }),
    })
    await runCycle(config, 'cycle-grant2', d)
    expect(executeGrantAccess).not.toHaveBeenCalled()
  })

  it('skips voting when rubric.canVote is false and minting when canMint is false', async () => {
    const d = deps({ reads: fakeReads({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, canVote: false, canMint: false })) }) })
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
    const d = deps({ reads: fakeReads({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, canVote: false })) }) })
    await runCycle(config, 'c-novote', d)
    expect(skipReasons(d.activity.record as any).some((r) => /no on-chain voter rubric/.test(r))).toBe(true)
  })

  it('records a skip reason when mint is enabled but the datanet has no publisher spec', async () => {
    const cfg = StrategyConfigSchema.parse({
      ...config,
      datanets: { '9': { vote: false, mint: true, strictness: 'aggressive', adapter: 'hyperliquid' } },
    })
    const d = deps({ reads: fakeReads({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, canMint: false })) }) })
    await runCycle(cfg, 'c-nomint', d)
    expect(skipReasons(d.activity.record as any).some((r) => /no on-chain publisher spec/.test(r))).toBe(true)
  })

  it('skips vote scoring entirely when the per-cycle vote budget is already exhausted', async () => {
    const scorePod = vi.fn(async () => ({ score: 9, reason: 'good' }))
    const d = deps({
      scorers: fakeScorers({ voteScorerFor: () => ({ scorer: { scorePod } }) }),
      ledger: { startCycle: vi.fn(), canVote: () => false, canMint: () => true } as unknown as CycleDeps['ledger'],
    })
    await runCycle(config, 'c-novotebudget', d)
    expect(scorePod).not.toHaveBeenCalled() // no wasted LLM spend
    expect((d.executor.executeVote as any).mock.calls.length).toBe(0)
    // but the dashboard still learns why the datanet is idle
    expect(skipReasons(d.activity.record as any).some((r) => /vote budget\/rate exhausted/.test(r))).toBe(true)
  })

  it('skips mint discovery when the mint budget is exhausted (no wasted adapter/LLM work)', async () => {
    const discover = vi.fn(async () => [{ canonicalKey: 'k1', podName: 'p', podDescription: 'd', dataset: {} }])
    const d = deps({
      adapters: adapterHub({ get: () => ({ id: 'hyperliquid', discover }) }),
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
    const d = deps({ reads: fakeReads({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, canVote: true, canMint: false })) }) })
    await runCycle(config, 'c-voted-nomint', d)
    // votes happened (datanet 9 + 2 both vote), so no publisher-spec skip should be persisted
    expect(skipReasons(d.activity.record as any).some((r) => /no on-chain publisher spec/.test(r))).toBe(false)
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
    expect(skipReasons(d.activity.record as any).some((r) => /adapter "typo-adapter" is not registered/.test(r))).toBe(true)
  })

  it('records a skip reason when candidates are discovered but none pass scoring/dedup', async () => {
    // mint-only datanet (vote:false) so it is idle this cycle and the skip is surfaced.
    const cfg = StrategyConfigSchema.parse({
      ...config,
      datanets: { '9': { vote: false, mint: true, strictness: 'aggressive', adapter: 'hyperliquid' } },
    })
    const d = deps({ scorers: fakeScorers({ candidateScorer: { scoreCandidate: async () => ({ score: 1, reason: 'weak' }) } }) }) // below aggressive like-threshold
    await runCycle(cfg, 'c-allrejected', d)
    expect((d.executor.executeMint as any).mock.calls.length).toBe(0)
    expect(skipReasons(d.activity.record as any).some((r) => /discovered but none passed scoring\/dedup/.test(r))).toBe(true)
  })

  it('isolates a per-datanet failure: a throwing getRubric skips that datanet, others proceed', async () => {
    const d = deps({
      reads: fakeReads({ getRubric: vi.fn(async (id: string) => {
        if (id === '2') throw new Error('RPC rate limit')
        return rubric({ datanetId: id })
      }) }),
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
    expect(d.dedup.recordVote).toHaveBeenCalledWith('9', 'p1')
    expect(d.dedup.recordMint).toHaveBeenCalledWith('9', 'k1')
    // datanet 2 has vote:true, mint:false → vote recorded, no mint call
    expect(d.dedup.recordVote).toHaveBeenCalledWith('2', 'p1')
    expect((d.dedup.recordMint as ReturnType<typeof vi.fn>).mock.calls.filter((c: string[]) => c[0] === '2')).toEqual([])
  })

  it('calls registerVoteOnPlatform with (podId, txHash) on an executed vote', async () => {
    const registerVoteOnPlatform = vi.fn(async () => {})
    const d = deps({ activity: fakeActivity({ registerVoteOnPlatform }) })
    await runCycle(config, 'c-plat', d)
    // default executeVote returns txHash:'0xvote'; datanets 9 and 2 both vote on pod p1
    expect(registerVoteOnPlatform).toHaveBeenCalledWith('p1', '0xvote')
    expect(registerVoteOnPlatform).toHaveBeenCalledTimes(2) // once per vote-enabled datanet
  })

  it('does not call registerVoteOnPlatform when txHash is absent', async () => {
    const registerVoteOnPlatform = vi.fn(async () => {})
    const d = deps({
      activity: fakeActivity({ registerVoteOnPlatform }),
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
      activity: fakeActivity({ registerVoteOnPlatform }),
      executor: {
        executeVote: vi.fn(async () => ({ ok: false as const, status: 'error' as const, txHash: '0xerr', detail: 'fail' })),
        executeMint: vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xm' })),
      } as unknown as CycleDeps['executor'],
    })
    await runCycle(config, 'c-plat-err', d)
    expect(registerVoteOnPlatform).not.toHaveBeenCalled()
  })

  it('a rejected registerVoteOnPlatform never aborts the cycle', async () => {
    const d = deps({ activity: fakeActivity({ registerVoteOnPlatform: vi.fn(async () => { throw new Error('api down') }) }) })
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
      dedup: fakeDedup({ grants: grantCache() }),
    })
    const report = await runCycle(config, 'cycle-skip', d)

    // the expensive paths were never entered
    expect(d.reads.getPodsAndFilter).not.toHaveBeenCalled()
    expect((d.executor.executeVote as any).mock.calls.length).toBe(0)
    expect((d.executor.executeMint as any).mock.calls.length).toBe(0)

    // the skip is visible in the report and the activity log
    const d9 = report.datanets.find((r) => r.datanetId === '9')!
    expect(d9.skipped).toMatch(/subnet access not granted/)
    const skips = (d.activity.record as ReturnType<typeof vi.fn>).mock.calls
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
      dedup: fakeDedup({ grants: grantCache({ granted: async () => new Set(['9', '2']) }) }),
    })
    let report = await runCycle(config, 'g1', granted)
    expect(report.datanets.every((r) => r.skipped === undefined)).toBe(true)
    expect(granted.reads.getPodsAndFilter).toHaveBeenCalled()

    // grant succeeds this cycle → proceeds immediately
    const grantsNow = deps({
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess: vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xg' })),
      } as unknown as CycleDeps['executor'],
      dedup: fakeDedup({ grants: grantCache() }),
    })
    report = await runCycle(config, 'g2', grantsNow)
    expect(report.datanets.every((r) => r.skipped === undefined)).toBe(true)

    // no subnetUuid (pre-subnet metadata) → gate not applicable, proceeds
    const noSubnet = deps({
      reads: fakeReads({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: '' })) }),
      dedup: fakeDedup({ grants: grantCache() }),
    })
    report = await runCycle(config, 'g3', noSubnet)
    expect(report.datanets.every((r) => r.skipped === undefined)).toBe(true)
    expect(noSubnet.reads.getPodsAndFilter).toHaveBeenCalled()
  })

  it('records a skip activity entry when a datanet fails (rubric error) so the dashboard sees it', async () => {
    const d = deps({
      reads: fakeReads({ getRubric: vi.fn(async (id: string) => {
        if (id === '2') throw new Error('RPC rate limit')
        return rubric({ datanetId: id })
      }) }),
    })
    await runCycle(config, 'c-err', d)
    const skips = (d.activity.record as ReturnType<typeof vi.fn>).mock.calls
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
      reads: fakeReads({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: 'cm-42', economics: { accessFeeReppo: 0, accessFeeToken: exyToken, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' } })) }),
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      dedup: fakeDedup({ grants: grantCache() }),
      supportsNonReppoGrants: false,
    })
    const report = await runCycle(nonReppoConfig, 'c-nonreppo-off', d)
    expect(executeGrantAccess).not.toHaveBeenCalled() // never fires an unsupported flag
    expect(d.reads.getPodsAndFilter).not.toHaveBeenCalled() // skipped before scoring
    const d42 = report.datanets.find((r) => r.datanetId === '42')!
    expect(d42.skipped).toMatch(/non-REPPO access fee needs reppo CLI ≥ 0\.8\.5/)
    expect(skipReasons(d.activity.record as any).some((r) => /non-REPPO access fee needs reppo CLI ≥ 0\.8\.5/.test(r))).toBe(true)
  })

  it('grants a non-REPPO-fee datanet with token=primary when the CLI supports it (capability ON)', async () => {
    const executeGrantAccess = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xg' }))
    const d = deps({
      reads: fakeReads({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: 'cm-42', economics: { accessFeeReppo: 0, accessFeeToken: exyToken, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' } })) }),
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      dedup: fakeDedup({ grants: grantCache() }),
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
      reads: fakeReads({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: 'cm-42', economics: { accessFeeReppo: 0, accessFeeToken: exyToken, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' } })) }),
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      dedup: fakeDedup({ grants: grantCache() }),
      supportsNonReppoGrants: true,
      onchain: onchainReads({ wallet: walletReads({ readTokenBalance }) }),
    })
    const report = await runCycle(nonReppoConfig, 'c-insufficient', d)
    expect(readTokenBalance).toHaveBeenCalledWith(exyToken.address, '0xWallet')
    expect(executeGrantAccess).not.toHaveBeenCalled()       // never paid — pre-check stopped it
    expect(d.reads.getPodsAndFilter).not.toHaveBeenCalled()       // skipped before scoring
    const d42 = report.datanets.find((r) => r.datanetId === '42')!
    expect(d42.skipped).toMatch(/insufficient EXY balance for access fee/)
    expect(skipReasons(d.activity.record as any).some((r) => /insufficient EXY balance/.test(r))).toBe(true)
  })

  it('grants a non-REPPO datanet with token=primary when the balance covers the fee', async () => {
    const executeGrantAccess = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xg' }))
    const readTokenBalance = vi.fn(async () => 50_000_000n) // exactly 50 EXY @ 6 dp — enough
    const d = deps({
      reads: fakeReads({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: 'cm-42', economics: { accessFeeReppo: 0, accessFeeToken: exyToken, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' } })) }),
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      dedup: fakeDedup({ grants: grantCache() }),
      supportsNonReppoGrants: true,
      onchain: onchainReads({ wallet: walletReads({ readTokenBalance }) }),
    })
    const report = await runCycle(nonReppoConfig, 'c-sufficient', d)
    expect(executeGrantAccess).toHaveBeenCalledWith('42', 'primary')
    expect(report.datanets.find((r) => r.datanetId === '42')!.skipped).toBeUndefined()
  })

  it('does NOT block the grant when no balance reader is wired (CLI still fails closed)', async () => {
    const executeGrantAccess = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xg' }))
    const d = deps({
      reads: fakeReads({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: 'cm-42', economics: { accessFeeReppo: 0, accessFeeToken: exyToken, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' } })) }),
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      dedup: fakeDedup({ grants: grantCache() }),
      supportsNonReppoGrants: true,
      // onchain intentionally omitted (no RPC configured) — no balance pre-check
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
      reads: fakeReads({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: 'cm-42', economics: { accessFeeReppo: 0, accessFeeToken: exyToken, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' } })) }),
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess,
      } as unknown as CycleDeps['executor'],
      dedup: fakeDedup({ grants: grantCache() }),
      supportsNonReppoGrants: true,
      onchain: onchainReads({ wallet: walletReads({ readTokenBalance: vi.fn(async () => 100_000_000n) }) }),
    })
    await runCycle(nonReppoConfig, 'c-grantfee', d)
    const grants = (d.activity.record as ReturnType<typeof vi.fn>).mock.calls
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
      dedup: fakeDedup({ grants: grantCache() }),
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
    expect(d.dedup.recordVote).toHaveBeenCalledWith('9', 'p1') // permanent error → dedup so it stops retrying
  })

  it('evicts the granted-subnet cache when a vote fails VOTER_LACKS_SUBNET_ACCESS despite the cache', async () => {
    const revokeGrant = vi.fn()
    const d = deps({
      executor: {
        executeVote: vi.fn(async () => ({ ok: false, status: 'error', detail: '{"error":{"code":"VOTER_LACKS_SUBNET_ACCESS"}}' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeGrantAccess: vi.fn(),
      } as unknown as CycleDeps['executor'],
      dedup: fakeDedup({ grants: grantCache({ granted: async () => new Set(['9', '2']), revoke: revokeGrant }) }), // cache says granted — stale
    })
    await runCycle(config, 'c-stale', d)
    expect(revokeGrant).toHaveBeenCalledWith('9') // evicted → next cycle re-attempts the grant
    expect(d.dedup.recordVote).not.toHaveBeenCalled()   // NOT recorded as voted — retried after re-grant
  })

  it('records dedup ONLY on executed — refused AND errored are not recorded (so retries are not blocked)', async () => {
    const refused = deps({
      executor: { executeVote: vi.fn(async () => ({ ok: false, status: 'refused-budget' })), executeMint: vi.fn(async () => ({ ok: false, status: 'refused-budget' })) } as unknown as CycleDeps['executor'],
    })
    await runCycle(config, 'c6', refused)
    expect(refused.dedup.recordVote).not.toHaveBeenCalled()
    expect(refused.dedup.recordMint).not.toHaveBeenCalled()

    const errored = deps({
      executor: { executeVote: vi.fn(async () => ({ ok: false, status: 'error', detail: 'no txHash' })), executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })) } as unknown as CycleDeps['executor'],
    })
    await runCycle(config, 'c7', errored)
    expect(errored.dedup.recordVote).not.toHaveBeenCalled()        // errored vote NOT recorded → retried next cycle (idempotency key guards double-spend)
    expect(errored.dedup.recordMint).toHaveBeenCalledWith('9', 'k1') // executed mint IS recorded
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
      reads: fakeReads({ getPodsAndFilter: vi.fn(async () => ({
        pods: [
          { podId: 'a', validityEpoch: '100', name: 'A', description: 'd' },
          { podId: 'b', validityEpoch: '100', name: 'B', description: 'd' },
          { podId: 'c', validityEpoch: '100', name: 'C', description: 'd' },
        ],
        filter: { currentEpoch: '100', ownPodIds: [], votedPodIds: [] },
      })) }),
      executor: { executeVote: vi.fn(async () => { cast++; return { ok: true, status: 'executed', txHash: '0xv' } }), executeMint: vi.fn() } as unknown as CycleDeps['executor'],
      ledger: { startCycle: vi.fn(), canVote: () => cast < CAP, canMint: () => false, votesRemaining: () => Math.max(0, CAP - cast) } as unknown as CycleDeps['ledger'],
      activity: fakeActivity({ record: (e) => { activity.push(e) } }),
    })
    await runCycle(single, 'c-defer', d)
    expect((d.executor.executeVote as any).mock.calls.length).toBe(1) // only the one that fits is attempted; the rest are not
    expect(activity.filter((e) => e.kind === 'vote')).toHaveLength(1)  // exactly one vote row (the executed one), no per-pod deferred rows
    const skips = activity.filter((e) => e.kind === 'skip')
    expect(skips).toHaveLength(1)
    expect(skips[0].reason).toMatch(/2 votes deferred to next cycle/)
    expect(d.dedup.recordVote).toHaveBeenCalledTimes(1)
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
      reads: fakeReads({ getEmissionsDue: async () => [
        { podId: '1', datanetId: '9', epoch: 101, reppo: 12.5 },
        { podId: '2', datanetId: '9', epoch: 101, reppo: 4 },
      ] }),
      dedup: fakeDedup({ seenClaims: async () => claimed, recordClaim: vi.fn((key: string) => { recorded.push(key) }) }),
      executor: claimExecutor(async () => ({ ok: true, status: 'executed', txHash: '0xc', gasEth: 0.0009 })),
    })
    const report = await runCycle(config, 'c1', d)
    expect(report.claims).toHaveLength(1) // only pod 1 (pod 2 already claimed)
    expect(recorded).toEqual(['1:101'])
    const activity = (d.activity.record as ReturnType<typeof vi.fn>).mock.calls
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
      reads: fakeReads(),                                    // no owner claims (default: nothing due)
      onchain: onchainReads({ wallet: walletReads({ getVoterEmissionsDue: async () => [{ podId: '1624', datanetId: '11', epoch: 105, reppo: 0 }] }) }),
      dedup: fakeDedup({ recordClaim: vi.fn((key: string) => { recorded.push(key) }) }),
      executor,
    })
    const report = await runCycle(config, 'c-voter', d)
    expect(executeVoterClaim).toHaveBeenCalledTimes(1)
    expect(report.claims).toHaveLength(1)
    expect(recorded).toEqual(['voter-1624:105'])            // voter-prefixed — no collision with owner key
    const activity = (d.activity.record as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0] as { kind: string; podId?: string; reppoClaimed?: number; detail?: string })
    const row = activity.find((e) => e.kind === 'claim' && e.podId === '1624')
    expect(row?.reppoClaimed).toBe(7)
    expect(row?.detail).toContain('voter')
  })

  it('skips the claim phase entirely when claimEmissions is false', async () => {
    let called = 0
    const d = deps({ reads: fakeReads({ getEmissionsDue: async () => { called++; return [] } }) })
    const cfg = StrategyConfigSchema.parse({ ...config, claimEmissions: false })
    const report = await runCycle(cfg, 'c2', d)
    expect(called).toBe(0)
    expect(report.claims).toEqual([])
    expect(report.emissionsDue).toEqual([]) // no scan ran → dashboard scans on its own
  })

  it('reports post-claim OWNER emissionsDue = scan minus this-cycle claims (dashboard reuse, no re-scan)', async () => {
    const d = deps({
      reads: fakeReads({ getEmissionsDue: async () => [
        { podId: '1', datanetId: '9', epoch: 101, reppo: 0 }, // claimed this cycle → cleared
        { podId: '2', datanetId: '9', epoch: 101, reppo: 0 }, // already claimed before → cleared
        { podId: '3', datanetId: '9', epoch: 101, reppo: 0 }, // claim fails → stays claimable
      ] }),
      dedup: fakeDedup({ seenClaims: async () => new Set<string>(['2:101']) }),
      executor: claimExecutor(async (i) => i.podId === '3'
        ? Promise.reject(new Error('boom'))
        : { ok: true, status: 'executed', txHash: '0xc', gasEth: 0 }),
    })
    const report = await runCycle(config, 'c-due', d)
    expect(report.emissionsDue.map((e) => `${e.podId}:${e.epoch}`)).toEqual(['3:101'])
  })

  it('isolates a single failing claim from the rest', async () => {
    const d = deps({
      reads: fakeReads({ getEmissionsDue: async () => [
        { podId: '1', datanetId: '9', epoch: 101, reppo: 5 },
        { podId: '2', datanetId: '9', epoch: 101, reppo: 5 },
      ] }),
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
    const d = deps({ reads: fakeReads({ getVeReppo: async () => 1031 }), executor: stakeExecutor(lock) })
    const cfg = cfgStake(2000)
    await runCycle(cfg, 'c1', d)
    await runCycle(cfg, 'c2', d) // same target → no second lock (guard)
    expect(lock).toHaveBeenCalledTimes(1)
    expect(lock.mock.calls[0][0]).toMatchObject({ amountReppo: 969, durationSeconds: 30 * 86400 })
  })

  it('does not lock when veREPPO is at/above target', async () => {
    const lock = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xlock' }))
    const d = deps({ reads: fakeReads({ getVeReppo: async () => 1700 }), executor: stakeExecutor(lock) })
    await runCycle(cfgStake(1700), 'c-ata', d)
    expect(lock).not.toHaveBeenCalled()
  })

  it('a lock failure does not abort the cycle', async () => {
    const lock = vi.fn(async () => { throw new Error('INSUFFICIENT_REPPO_BALANCE') })
    const d = deps({ reads: fakeReads({ getVeReppo: async () => 0 }), executor: stakeExecutor(lock) })
    const r = await runCycle(cfgStake(1500), 'c-fail', d)
    expect(r).toBeDefined() // cycle completed despite the lock throwing
  })

  it('SKIPS the top-up on a failed balance read (never locks the full target)', async () => {
    const lock = vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xlock' }))
    // null = read failure. Must NOT be treated as 0 (which would lock the full target).
    const d = deps({ reads: fakeReads({ getVeReppo: async () => null }), executor: stakeExecutor(lock) })
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
    const d = deps({ reads: fakeReads({ getVeReppo: async () => 0 }), executor: stakeExecutor(lock) })
    const cfg = cfgStake(1800)
    await runCycle(cfg, 'c1', d) // attempt 1 fails — must NOT latch
    await runCycle(cfg, 'c2', d) // attempt 2 retries and succeeds
    expect(lock).toHaveBeenCalledTimes(2)
  })

  it('records the lock-failure reason in the stake activity so the operator sees WHY', async () => {
    const acts: any[] = []
    const lock = vi.fn(async () => ({ ok: false as const, status: 'error' as const, detail: 'INSUFFICIENT_REPPO_BALANCE' }))
    const d = deps({ reads: fakeReads({ getVeReppo: async () => 0 }), executor: stakeExecutor(lock), activity: fakeActivity({ record: (e: any) => acts.push(e) }) })
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
    const d = deps({ reads: fakeReads({ getVeReppo: async () => 100 }), executor: stakeExecutor(lock) })
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
    const d = deps({ scorers: fakeScorers({ voteScorerFor: () => ({ skip: 'no API key for google' }) }) })
    const report = await runCycle(config, 'c-skip', d)
    for (const dn of report.datanets) expect(dn.votes).toHaveLength(0)
    expect((d.executor.executeVote as any).mock.calls.length).toBe(0)
    expect(skipReasons(d.activity.record as any).some((r) => /no API key for google/.test(r))).toBe(true)
  })
})

describe('datanet yield', () => {
  // Single vote-enabled datanet (mirrors the simplest passing vote test's arrangement:
  // rubric canVote true, getPodsAndFilter returns ≥1 pod via the deps() factory default)
  // so datanetEconomics has exactly one entry per assertion below.
  const yieldCfg = StrategyConfigSchema.parse({
    horizonDays: 30, cadenceHours: 6,
    stake: { lockReppo: 0, lockDurationDays: 30 },
    budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 1000, mintGasEthMax: 1, claimGasEthMax: 1 },
    datanets: { '9': { vote: true, mint: false, strictness: 'aggressive' } },
  })

  it('computes yield onto a vote-scoped rubric clone (shared rubric NOT mutated); yield is snapshot-only, writes NO activity row', async () => {
    const recordActivity = vi.fn()
    let sharedRubric: DatanetRubric | undefined
    let scorerRubric: VoteRubric | undefined
    const d = deps({
      activity: fakeActivity({ record: recordActivity }),
      // Capture BOTH the shared (process-cached in production) rubric object and the
      // rubric the scorer receives: yield must ride a vote-scoped CLONE — mutating the
      // shared object leaked the vote-only economics block into the mint path (which
      // had to defensively strip it) and into later cycles.
      reads: fakeReads({ getRubric: vi.fn(async (id: string) => {
        sharedRubric = rubric({ datanetId: id })
        return sharedRubric
      }) }),
      scorers: fakeScorers({ voteScorerFor: () => ({ scorer: { scorePod: async (_pod, r) => { scorerRubric = r; return { score: 9, reason: 'good' } } } }) }),
      onchain: onchainReads({
        getEpochVoteVolume: vi.fn(async (podIds: string[]) => {
          expect(podIds.length).toBeGreaterThan(0) // called with the fetched pods
          return { epoch: 7, totalRaw: 2n * 10n ** 18n }
        }),
      }),
    })
    const report = await runCycle(yieldCfg, 'c1', d)
    expect(report.datanetEconomics).toHaveLength(1)
    expect(report.datanetEconomics[0]).toMatchObject({ epoch: 7, epochVoteVolume: 2 })
    expect(report.datanetEconomics[0].unavailableReason).toBeUndefined()
    // Yield is STATE (snapshot-only) — it must NOT spam the activity log: one info row
    // per datanet per cycle drowned the real vote/mint/claim events.
    expect(recordActivity.mock.calls.map((c) => c[0]).find((e) => e.kind === 'info')).toBeUndefined()
    // The scorer saw the yield on its rubric (a clone of the shared object)…
    expect(scorerRubric?.economics.currentYield?.epoch).toBe(7)
    expect(scorerRubric).not.toBe(sharedRubric)
    // …while the shared rubric stayed untouched (mint path + later cycles reuse it).
    expect(sharedRubric && 'currentYield' in sharedRubric.economics).toBe(false)
  })

  it('volume read throws: yield unavailable with the error, datanet still votes', async () => {
    const recordActivity = vi.fn()
    const d = deps({
      activity: fakeActivity({ record: recordActivity }),
      onchain: onchainReads({ getEpochVoteVolume: vi.fn(async () => { throw new Error('rpc down') }) }),
    })
    const report = await runCycle(yieldCfg, 'c1', d)
    expect(report.datanets[0].error).toBeUndefined()      // per-datanet isolation held
    expect(report.datanetEconomics[0].yieldPerVote).toBeNull()
    // The failure detail rides the snapshot (dashboard chips), not an activity row.
    expect(report.datanetEconomics[0].unavailableReason).toBe('rpc down')
    expect(recordActivity.mock.calls.map((c) => c[0]).find((e) => e.kind === 'info')).toBeUndefined()
  })

  it('volume read error is REDACTED before it reaches the snapshot (dashboard path)', async () => {
    // unavailableReason rides the snapshot to the dashboard — a path with no redaction
    // of its own (activity rows are scrubbed on write; the snapshot is not). An RPC
    // error can echo the full provider URL including the embedded API key.
    const d = deps({
      onchain: onchainReads({
        getEpochVoteVolume: vi.fn(async () => {
          throw new Error('Invalid URL: https://eth-mainnet.g.alchemy.com/v2/SUPERSECRETKEY123')
        }),
      }),
    })
    const report = await runCycle(yieldCfg, 'c1', d)
    const reason = report.datanetEconomics[0].unavailableReason ?? ''
    expect(reason).not.toContain('SUPERSECRETKEY123')
    expect(reason).toContain('alchemy.com') // host survives; only the key is scrubbed
  })

  it('onchain absent (no RPC): yield reported unavailable WITHOUT a failure reason', async () => {
    const recordActivity = vi.fn()
    const report = await runCycle(yieldCfg, 'c1', deps({ activity: fakeActivity({ record: recordActivity }) }))
    expect(report.datanetEconomics[0].epochVoteVolume).toBeNull()
    expect(report.datanetEconomics[0].unavailableReason).toBeUndefined() // not wired ≠ failed
  })

  it('onchain present but wallet tier absent: yield still works, voter claims + balance pre-check stay off', async () => {
    // RPC-only node (wallet address underivable): the RPC tier is wired, the wallet tier is not.
    const executeVoterClaim = vi.fn()
    const d = deps({
      onchain: onchainReads({ getEpochVoteVolume: async () => ({ epoch: 7, totalRaw: 10n ** 18n }) }),
      executor: {
        executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
        executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
        executeClaim: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xc' })),
        executeVoterClaim,
      } as unknown as CycleDeps['executor'],
    })
    const report = await runCycle(yieldCfg, 'c-rpc-only', d)
    expect(report.datanetEconomics[0].epochVoteVolume).toBe(1) // RPC tier active
    expect(executeVoterClaim).not.toHaveBeenCalled()           // wallet tier off → no voter-claim scan
  })
})
