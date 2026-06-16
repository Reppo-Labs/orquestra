import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCycleDeps, buildTick, type CycleWiring } from './wiring.js'
import { DedupState } from './state.js'
import { StrategyConfigSchema } from '../config/schema.js'
import { appendActivity } from '../dashboard/activityLog.js'
import type { VoterPod } from '../voter/types.js'
import type { LlmProvider } from '../llm/model.js'

// Mocks for the post-cycle reporting/learning path (the reporting=false tests below
// never reach these). Shared spies via vi.hoisted so the factories can reference them.
const h = vi.hoisted(() => ({
  collectOutcomes: vi.fn(() => 0),
  runReflection: vi.fn(async () => {}),
  queryDatanetPodVotes: vi.fn(async () => [] as unknown[]),
  snap: { ts: 't', cycleId: 'c', balance: {}, votingPower: {}, emissionsDue: { totalReppo: 0, pods: [] }, budget: {}, epoch: { epoch: 5, epochStart: 0, epochDurationSeconds: 0, secondsRemaining: 0 } },
}))
vi.mock('../learn/collect.js', () => ({ collectOutcomes: h.collectOutcomes }))
vi.mock('../learn/reflect.js', () => ({ runReflection: h.runReflection }))
vi.mock('../reppo/queryOwnPods.js', () => ({ queryDatanetPodVotes: h.queryDatanetPodVotes }))
vi.mock('../dashboard/snapshot.js', () => ({
  collectSnapshot: vi.fn(async () => h.snap),
  writeSnapshot: vi.fn(),
  readSnapshot: vi.fn(() => h.snap),
}))

const config = StrategyConfigSchema.parse({
  horizonDays: 7, cadenceHours: 1,
  stake: { lockReppo: 0, lockDurationDays: 7 },
  budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 100, mintGasEthMax: 1 },
  datanets: { '2': { vote: true, mint: true, strictness: 'balanced', adapter: 'gdelt', adapterParams: { focus: 'energy', topN: 3 } } },
  notes: 'the brief',
})

const pod = (id: string, over: Partial<VoterPod> = {}): VoterPod =>
  ({ podId: id, validityEpoch: '100', name: `pod-${id}`, description: 'd', ...over })

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-wire-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function wiring(over: Partial<CycleWiring> = {}): CycleWiring {
  return {
    dataDir: dir, config,
    model: {} as CycleWiring['model'], // scorers aren't exercised in these tests
    providerKeyRegistry: new Map<LlmProvider, string>([['virtuals', 'acp-v']]),
    defaultProvider: 'virtuals',
    defaultModel: 'claude-opus-4-8',
    ledger: { startCycle: vi.fn(), state: {} } as unknown as CycleWiring['ledger'],
    executor: {} as CycleWiring['executor'],
    dedup: new DedupState(dir),
    adapters: [{ id: 'gdelt', matches: () => true, discover: async () => [] }],
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

  it('reads the operator brief live from config.notes (hot-reload, not captured at build)', () => {
    const w = wiring()
    const deps = buildCycleDeps(w)
    expect(deps.strategyFor!('2').brief).toBe('the brief')
    // Simulate buildTick swapping in a freshly-reloaded config with edited notes.
    w.config = { ...w.config, notes: 'edited via dashboard' }
    expect(deps.strategyFor!('2').brief).toBe('edited via dashboard')
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
    w.ledger = { startCycle: vi.fn(), updateCaps, state: { mintReppoSpent: 0, mintGasSpentEth: 0, voteGasSpentEth: 0, claimGasSpentEth: 0 } } as unknown as CycleWiring['ledger']
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

describe('buildTick self-learning (reporting path)', () => {
  beforeEach(() => {
    h.collectOutcomes.mockClear()
    h.runReflection.mockClear()
    h.queryDatanetPodVotes.mockClear()
    h.collectOutcomes.mockImplementation(() => 0)
  })

  const learnDeps = (w: CycleWiring) => buildCycleDeps({
    ...w,
    io: { listPods: async () => [], fetchContent: async () => '', getRubric: async () => { throw new Error('skip') }, emissionsDue: async () => ({ pods: [] }) },
  })

  it('collects outcomes per learn-datanet and reflects once per epoch when a learnModel is set', async () => {
    const w = wiring({ learnModel: {} as CycleWiring['model'] })
    const tick = buildTick(w, learnDeps(w), { reloadConfig: () => config })
    await tick()
    expect(h.collectOutcomes).toHaveBeenCalledWith(dir, '2', [], 5)
    expect(h.runReflection).toHaveBeenCalledTimes(1)
    await tick()                                       // same epoch → no second reflection
    expect(h.runReflection).toHaveBeenCalledTimes(1)
  })

  it('skips reflection entirely when no learnModel is configured (observe still runs)', async () => {
    const w = wiring() // no learnModel
    const tick = buildTick(w, learnDeps(w), { reloadConfig: () => config })
    await tick()
    expect(h.collectOutcomes).toHaveBeenCalled()
    expect(h.runReflection).not.toHaveBeenCalled()
  })

  it('a thrown collectOutcomes never aborts the tick (best-effort)', async () => {
    h.collectOutcomes.mockImplementation(() => { throw new Error('boom') })
    const w = wiring({ learnModel: {} as CycleWiring['model'] })
    const tick = buildTick(w, learnDeps(w), { reloadConfig: () => config })
    await expect(tick()).resolves.toBeUndefined()
  })
})

describe('buildCycleDeps voteScorerFor', () => {
  const cfgWith = (policy: Record<string, unknown>) => StrategyConfigSchema.parse({
    horizonDays: 7, cadenceHours: 1,
    stake: { lockReppo: 0, lockDurationDays: 7 },
    budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 100, mintGasEthMax: 1 },
    datanets: { '9': { vote: true, mint: false, strictness: 'balanced', ...policy } },
    notes: '',
  })

  it('resolves a scorer for a datanet using the node default provider', () => {
    const w = wiring({ config: cfgWith({}) })
    const deps = buildCycleDeps(w)
    expect('scorer' in deps.voteScorerFor('9')).toBe(true)
  })

  it('skips a datanet whose policy model has no key in the registry', () => {
    const w = wiring({ config: cfgWith({ model: { provider: 'google', model: 'gemini-3-pro' } }) })
    const deps = buildCycleDeps(w)
    const r = deps.voteScorerFor('9')
    expect('skip' in r).toBe(true)
    expect((r as { skip: string }).skip).toContain('google')
  })

  it('memoizes: same resolved provider:model reuses one scorer object', () => {
    // Two datanets, both on the node default (no override) → one scorer.
    const cfg = StrategyConfigSchema.parse({
      horizonDays: 7, cadenceHours: 1,
      stake: { lockReppo: 0, lockDurationDays: 7 },
      budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 100, mintGasEthMax: 1 },
      datanets: {
        '9': { vote: true, mint: false, strictness: 'balanced' },
        '10': { vote: true, mint: false, strictness: 'balanced' },
      },
      notes: '',
    })
    const deps = buildCycleDeps(wiring({ config: cfg }))
    const a = deps.voteScorerFor('9'), b = deps.voteScorerFor('10')
    expect('scorer' in a && 'scorer' in b).toBe(true)
    expect((a as { scorer: unknown }).scorer).toBe((b as { scorer: unknown }).scorer)
    // a repeat call for the same datanet returns the same cached object
    expect((deps.voteScorerFor('9') as { scorer: unknown }).scorer).toBe((a as { scorer: unknown }).scorer)
  })

  it('distinct resolved models get distinct scorers', () => {
    const cfg = StrategyConfigSchema.parse({
      horizonDays: 7, cadenceHours: 1,
      stake: { lockReppo: 0, lockDurationDays: 7 },
      budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 100, mintGasEthMax: 1 },
      datanets: {
        '9': { vote: true, mint: false, strictness: 'balanced' }, // node default (virtuals)
        '11': { vote: true, mint: false, strictness: 'balanced', model: { provider: 'virtuals', model: 'other-slug' } },
      },
      notes: '',
    })
    const deps = buildCycleDeps(wiring({ config: cfg }))
    const a = deps.voteScorerFor('9'), c = deps.voteScorerFor('11')
    expect((a as { scorer: unknown }).scorer).not.toBe((c as { scorer: unknown }).scorer)
  })
})
