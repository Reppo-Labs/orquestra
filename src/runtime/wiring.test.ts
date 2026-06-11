import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCycleDeps, buildTick, type CycleWiring } from './wiring.js'
import { DedupState } from './state.js'
import { StrategyConfigSchema } from '../config/schema.js'
import { appendActivity } from '../dashboard/activityLog.js'
import type { VoterPod } from '../voter/types.js'

const config = StrategyConfigSchema.parse({
  horizonDays: 7, cadenceHours: 1,
  stake: { lockReppo: 0, lockDurationDays: 7 },
  budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 100, mintGasEthMax: 1 },
  datanets: { '2': { vote: true, mint: true, strictness: 'balanced', adapter: 'gdelt', adapterParams: { focus: 'energy', topN: 3 } } },
})

const pod = (id: string, over: Partial<VoterPod> = {}): VoterPod =>
  ({ podId: id, validityEpoch: '100', name: `pod-${id}`, description: 'd', ...over })

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-wire-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function wiring(over: Partial<CycleWiring> = {}): CycleWiring {
  return {
    dataDir: dir, config,
    scorer: { scorePod: async () => ({ score: 8, reason: 'r' }) },
    model: {} as CycleWiring['model'], // scorers aren't exercised in these tests
    ledger: { startCycle: vi.fn(), state: {} } as unknown as CycleWiring['ledger'],
    executor: {} as CycleWiring['executor'],
    dedup: new DedupState(dir),
    adapters: [{ id: 'gdelt', matches: () => true, discover: async () => [] }],
    strategyBrief: 'the brief',
    ...over,
  }
}

describe('buildCycleDeps', () => {
  it('getPodsAndFilter enriches ONLY eligible pods (not own, not voted, current epoch)', async () => {
    const w = wiring()
    w.dedup.recordVote('2', 'voted1')
    const fetchContent = vi.fn(async () => 'fetched content')
    const deps = buildCycleDeps({
      ...w,
      io: {
        listPods: async (_id, opts) => opts.all
          ? [pod('p1', { url: 'https://x/1' }), pod('own1', { url: 'https://x/own' }), pod('voted1', { url: 'https://x/v' }), pod('old', { validityEpoch: '99', url: 'https://x/old' })]
          : [pod('own1')],
        fetchContent,
      },
    })
    const { pods, filter } = await deps.getPodsAndFilter('2')
    expect(fetchContent).toHaveBeenCalledTimes(1) // only p1 — own/voted/stale-epoch excluded
    expect(fetchContent).toHaveBeenCalledWith('https://x/1')
    expect(pods.find((p) => p.podId === 'p1')!.description).toContain('fetched content')
    expect(filter.ownPodIds).toEqual(['own1'])
    expect(filter.votedPodIds).toEqual(['voted1'])
    expect(filter.currentEpoch).toBe('100')
  })

  it('excludes pods whose NAME matches one of our executed mints (creator field is unreliable)', async () => {
    const w = wiring()
    // our mint record in the activity log — the name-based own-pod backstop source
    appendActivity(dir, {
      ts: '2026-06-11T00:00:00.000Z', cycleId: 'c1', kind: 'mint', datanetId: '2',
      canonicalKey: 'k1', podName: 'US sanctions Chinese firms over Iran arms', status: 'executed', txHash: '0xm',
    })
    const fetchContent = vi.fn(async () => 'content')
    const deps = buildCycleDeps({
      ...w,
      io: {
        listPods: async (_id, opts) => opts.all
          ? [pod('p1', { url: 'https://x/1' }), pod('mine', { name: 'US sanctions Chinese firms over Iran arms', url: 'https://x/mine' })]
          : [], // creator-based query returns NOTHING (the live failure mode)
        fetchContent,
      },
    })
    const { filter } = await deps.getPodsAndFilter('2')
    expect(filter.ownPodIds).toContain('mine')          // name-matched into the own set
    expect(fetchContent).toHaveBeenCalledTimes(1)       // 'mine' NOT enriched (no wasted fetch/scoring)
    expect(fetchContent).toHaveBeenCalledWith('https://x/1')
  })

  it('own-pods query failure disables the guard for the cycle instead of throwing', async () => {
    const deps = buildCycleDeps(wiring({
      io: {
        listPods: async (_id, opts) => {
          if (!opts.all) throw new Error('rpc down')
          return [pod('p1')]
        },
        fetchContent: async () => '',
      },
    }))
    const { filter } = await deps.getPodsAndFilter('2')
    expect(filter.ownPodIds).toEqual([]) // tolerated, not thrown
  })

  it('strategyFor merges the brief with per-datanet adapterParams (params win)', () => {
    const deps = buildCycleDeps(wiring())
    const s = deps.strategyFor!('2')
    expect(s.brief).toBe('the brief')
    expect(s.focus).toBe('energy')
    expect(s.topN).toBe(3)
  })

  it('dedup closures thread through to DedupState (vote, mint, grant, revoke)', async () => {
    const w = wiring()
    const deps = buildCycleDeps(w)
    deps.recordVote('2', 'p9')
    deps.recordMint('2', 'k9')
    deps.recordGrant!('2')
    expect(w.dedup.getVotedPodIds('2')).toContain('p9')
    expect(w.dedup.getMintedKeys('2')).toContain('k9')
    expect(await deps.grantedSubnets!()).toEqual(new Set(['2']))
    deps.revokeGrant!('2')
    expect(await deps.grantedSubnets!()).toEqual(new Set())
  })

  it('getExistingPodNames tolerates a failing list (returns [])', async () => {
    const deps = buildCycleDeps(wiring({
      io: { listPods: async () => { throw new Error('boom') }, fetchContent: async () => '' },
    }))
    expect(await deps.getExistingPodNames!('2')).toEqual([])
  })

  it('getAdapter routes by id; unknown id is undefined', () => {
    const deps = buildCycleDeps(wiring())
    expect(deps.getAdapter('gdelt')?.id).toBe('gdelt')
    expect(deps.getAdapter('nope')).toBeUndefined()
  })
})

describe('buildTick config hot-reload', () => {
  const altConfig = StrategyConfigSchema.parse({
    horizonDays: 7, cadenceHours: 1,
    stake: { lockReppo: 0, lockDurationDays: 7 },
    budget: { voteGasEthMax: 9, voteRateMaxPerCycle: 1, mintReppoMax: 1, mintGasEthMax: 1 },
    datanets: { '5': { vote: true, mint: false, strictness: 'balanced' } },
  })

  function tickWiring(reload: () => ReturnType<typeof StrategyConfigSchema.parse>) {
    const w = wiring()
    const updateCaps = vi.fn()
    w.ledger = { startCycle: vi.fn(), updateCaps, state: { mintReppoSpent: 0, mintGasSpentEth: 0, voteGasSpentEth: 0, claimGasSpentEth: 0, grantReppoSpent: 0 } } as unknown as CycleWiring['ledger']
    const ranWith: string[][] = []
    const deps = buildCycleDeps({ ...w, io: { listPods: async () => [], fetchContent: async () => '', getRubric: async () => { throw new Error('skip') }, emissionsDue: async () => ({ pods: [] }) } })
    return { w, deps, updateCaps, ranWith, reload }
  }

  it('re-reads config each tick: a datanet set change applies on the NEXT cycle', async () => {
    let current = config
    const { w, deps, updateCaps } = tickWiring(() => current)
    const tick = buildTick(w, deps, { reloadConfig: () => current, reporting: false })
    await tick() // datanets: ['2'] from `config`
    current = altConfig
    await tick() // must now use altConfig (datanet 5) + push caps
    expect(updateCaps).toHaveBeenCalledWith(altConfig.budget)
  })

  it('keeps the LAST-GOOD config when reload throws (loop never crashes)', async () => {
    let boom = false
    const { w, deps } = tickWiring(() => config)
    const tick = buildTick(w, deps, { reloadConfig: () => { if (boom) throw new Error('corrupt json'); return config }, reporting: false })
    await tick()
    boom = true
    await expect(tick()).resolves.toBeUndefined() // tolerated, last-good used
  })
})
