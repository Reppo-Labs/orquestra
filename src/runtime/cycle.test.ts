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
  canVote: true, canMint: true, status: 'ACTIVE',
  economics: { accessFeeReppo: 0, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'REPPO' },
  ...over,
})

const config = StrategyConfigSchema.parse({
  horizonDays: 30, cadenceHours: 6,
  stake: { lockReppo: 0, lockDurationDays: 30 },
  budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 1000, mintGasEthMax: 1 },
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
    const d9 = report.find((r) => r.datanetId === '9')!
    expect(d9.votes[0].txHash).toBe('0xvote')
    expect(d9.mints[0].txHash).toBe('0xmint')
    expect(report.find((r) => r.datanetId === '2')!.mints).toEqual([])
  })

  it('skips voting when rubric.canVote is false and minting when canMint is false', async () => {
    const d = deps({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, canVote: false, canMint: false })) })
    const report = await runCycle(config, 'c2', d)
    expect((d.executor.executeVote as any).mock.calls.length).toBe(0)
    expect((d.executor.executeMint as any).mock.calls.length).toBe(0)
    expect(report.every((r) => r.votes.length === 0 && r.mints.length === 0)).toBe(true)
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
    const d2 = report.find((r) => r.datanetId === '2')!
    expect(d2.error).toMatch(/RPC rate limit/)
    expect(d2.votes).toEqual([])
    const d9 = report.find((r) => r.datanetId === '9')!
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

  it('does NOT record a vote refused by budget, but DOES record one that errored (possibly landed)', async () => {
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
    expect(errored.recordVote).toHaveBeenCalledWith('9', 'p1') // errored vote recorded → won't re-vote
  })
})
