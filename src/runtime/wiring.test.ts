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
import type { DatanetRubric } from '../rubric/types.js'
import type { CandidatePod } from '../adapter/types.js'

// Mocks for the post-cycle reporting/learning path (the reporting=false tests below
// never reach these). Shared spies via vi.hoisted so the factories can reference them.
const h = vi.hoisted(() => ({
  collectOutcomes: vi.fn(() => 0),
  runReflection: vi.fn(async () => {}),
  queryDatanetPodVotes: vi.fn(async () => [] as unknown[]),
  // Spy on model resolution so the mint-default test can assert WHICH provider/key/slug the
  // node default resolved to. Returns a sentinel LanguageModel — scoring is stubbed out below.
  resolveModel: vi.fn((provider: string, _key: string, model?: string) => ({ provider, model } as unknown)),
  // Stub the scorer's LLM call so the mint-default test never hits the network; returns a fixed score.
  generateObjectWithRetry: vi.fn(async () => ({ score: 5, reason: 'r' })),
  writeSnapshot: vi.fn(),
  attachSnapshotLlm: vi.fn(),
  snap: { ts: 't', cycleId: 'c', balance: {}, votingPower: {}, emissionsDue: { totalReppo: 0, pods: [] }, budget: {}, epoch: { epoch: 5, epochStart: 0, epochDurationSeconds: 0, secondsRemaining: 0 } },
}))
// Stub the datanet catalog so discovery + token-enrichment never spawn the real `reppo`
// CLI in unit tests (its variable spawn latency intermittently blew the 5s tick timeout).
vi.mock('../reppo/listDatanets.js', () => ({ listDatanetsJson: vi.fn(async () => []) }))
vi.mock('../learn/collect.js', () => ({ collectOutcomes: h.collectOutcomes }))
vi.mock('../learn/reflect.js', () => ({ runReflection: h.runReflection }))
vi.mock('../reppo/queryOwnPods.js', () => ({ queryDatanetPodVotes: h.queryDatanetPodVotes }))
vi.mock('../dashboard/snapshot.js', () => ({
  collectSnapshot: vi.fn(async () => h.snap),
  writeSnapshot: h.writeSnapshot,
  readSnapshot: vi.fn(() => h.snap),
  attachSnapshotLlm: h.attachSnapshotLlm,
}))
// Preserve the rest of llm/model.js (DEFAULT_MODEL, LlmProviderEnum, KNOWN_MODELS used by the
// schema + by resolveScoringModel) and only spy resolveModel. resolveScoringModel imports
// resolveModel from this module, so the spy also covers the vote path (harmless — those tests
// don't assert resolveModel output).
vi.mock('../llm/model.js', async (orig) => {
  const actual = await orig<typeof import('../llm/model.js')>()
  return { ...actual, resolveModel: h.resolveModel }
})
vi.mock('../llm/generate.js', async (orig) => {
  const actual = await orig<typeof import('../llm/generate.js')>()
  return { ...actual, generateObjectWithRetry: h.generateObjectWithRetry }
})

const config = StrategyConfigSchema.parse({
  horizonDays: 7, cadenceHours: 1,
  stake: { lockReppo: 0, lockDurationDays: 7 },
  budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 100, mintGasEthMax: 1 },
  datanets: { '2': { vote: true, mint: true, strictness: 'balanced', adapter: 'gdelt', adapterParams: { focus: 'energy', topN: 3 } } },
  notes: 'the brief',
})

// Default description === name (title-only), matching parsePods when the CLI provides no
// writeup — so the url-fetch enrichment runs. A test that wants the "already has writeup"
// path passes a distinct `description` override.
const pod = (id: string, over: Partial<VoterPod> = {}): VoterPod =>
  ({ podId: id, validityEpoch: '100', name: `pod-${id}`, description: `pod-${id}`, ...over })

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

  it('does NOT fetch the url when the pod already has a real writeup (avoids clobbering with SPA-shell HTML)', async () => {
    const w = wiring()
    const fetchContent = vi.fn(async () => '<!doctype html> app shell junk')
    const deps = buildCycleDeps({
      ...w,
      io: {
        listPods: async (_id, opts) => opts.all
          ? [pod('withWriteup', { url: 'https://araistotle/spa/1', description: 'ArAIstotle YES 0.45 | full analysis + sources' }),
             pod('titleOnly', { url: 'https://x/2' })]
          : [],
        fetchContent,
      },
    })
    const { pods } = await deps.getPodsAndFilter('2')
    // Only the title-only pod is fetched; the one with a writeup keeps its CLI description.
    expect(fetchContent).toHaveBeenCalledTimes(1)
    expect(fetchContent).toHaveBeenCalledWith('https://x/2')
    expect(pods.find((p) => p.podId === 'withWriteup')!.description).toBe('ArAIstotle YES 0.45 | full analysis + sources')
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

  it('registerVoteOnPlatform is always wired (cred check deferred to call time)', () => {
    const deps = buildCycleDeps(wiring())
    expect(deps.registerVoteOnPlatform).toBeDefined()
  })

  it('registerVoteOnPlatform is a no-op when REPPO_AGENT_ID / REPPO_API_KEY are absent', async () => {
    const savedId = process.env.REPPO_AGENT_ID
    const savedKey = process.env.REPPO_API_KEY
    delete process.env.REPPO_AGENT_ID
    delete process.env.REPPO_API_KEY
    try {
      const deps = buildCycleDeps(wiring())
      await expect(deps.registerVoteOnPlatform!('pod-1', '0xtx')).resolves.toBeUndefined()
    } finally {
      if (savedId !== undefined) process.env.REPPO_AGENT_ID = savedId
      if (savedKey !== undefined) process.env.REPPO_API_KEY = savedKey
    }
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

  it('detects a video pod: sets mediaUrl/mediaType and does NOT text-enrich it', async () => {
    const w = wiring({ providerKeyRegistry: new Map<LlmProvider, string>([['google', 'gk']]) })
    const detectType = vi.fn(async (url: string) =>
      url.endsWith('.mp4') ? { mediaType: 'video/mp4', contentLength: 1000 } : null)
    const fetchContent = vi.fn(async () => 'TEXT')
    const deps = buildCycleDeps({
      ...w,
      io: {
        listPods: async (_id, opts) => opts.all
          ? [pod('vid', { url: 'https://x/clip.mp4' }), pod('txt', { url: 'https://x/doc.json' })]
          : [],
        fetchContent,
        detectType,
      },
    })
    const { pods } = await deps.getPodsAndFilter('2')
    const vid = pods.find((p) => p.podId === 'vid')!
    const txt = pods.find((p) => p.podId === 'txt')!
    expect(vid.mediaUrl).toBe('https://x/clip.mp4')
    expect(vid.mediaType).toBe('video/mp4')
    expect(fetchContent).toHaveBeenCalledTimes(1)            // only the text pod
    expect(fetchContent).toHaveBeenCalledWith('https://x/doc.json')
    expect(txt.description).toContain('TEXT')
    expect(txt.mediaUrl).toBeUndefined()
  })

  it('resolves a Google Drive viewer URL to a direct download before probing → routes to the video path', async () => {
    const w = wiring({ providerKeyRegistry: new Map<LlmProvider, string>([['google', 'gk']]) })
    // The Drive viewer URL serves HTML; only the resolved usercontent download URL probes as video.
    const detectType = vi.fn(async (url: string) =>
      url.startsWith('https://drive.usercontent.google.com/download')
        ? { mediaType: 'video/mp4', contentLength: 1000 }
        : null)
    const fetchContent = vi.fn(async () => 'TEXT')
    const deps = buildCycleDeps({
      ...w,
      io: {
        listPods: async (_id, opts) => opts.all
          ? [pod('vid', { url: 'https://drive.google.com/file/d/1AbC_dEfGhI/view?usp=sharing' })]
          : [],
        fetchContent,
        detectType,
      },
    })
    const { pods } = await deps.getPodsAndFilter('2')
    const vid = pods.find((p) => p.podId === 'vid')!
    // detectType was probed with the RESOLVED url, and the resolved url is what ingestVideo will fetch.
    expect(detectType).toHaveBeenCalledWith('https://drive.usercontent.google.com/download?id=1AbC_dEfGhI&export=download&confirm=t')
    expect(vid.mediaUrl).toBe('https://drive.usercontent.google.com/download?id=1AbC_dEfGhI&export=download&confirm=t')
    expect(vid.mediaType).toBe('video/mp4')
    expect(fetchContent).not.toHaveBeenCalled() // never text-fetched
  })

  it('treats a Drive-resolved URL serving application/octet-stream as video and coerces mediaType to video/mp4', async () => {
    const w = wiring({ providerKeyRegistry: new Map<LlmProvider, string>([['google', 'gk']]) })
    // Drive's download endpoint often serves a generic binary type, not video/mp4.
    const detectType = vi.fn(async () => ({ mediaType: 'application/octet-stream', contentLength: 1000 }))
    const fetchContent = vi.fn(async () => 'TEXT')
    const deps = buildCycleDeps({
      ...w,
      io: {
        listPods: async (_id, opts) => opts.all
          ? [pod('vid', { url: 'https://drive.google.com/file/d/1AbC_dEfGhI/view' })]
          : [],
        fetchContent,
        detectType,
      },
    })
    const { pods } = await deps.getPodsAndFilter('2')
    const vid = pods.find((p) => p.podId === 'vid')!
    expect(vid.mediaUrl).toBe('https://drive.usercontent.google.com/download?id=1AbC_dEfGhI&export=download&confirm=t')
    expect(vid.mediaType).toBe('video/mp4') // coerced: Gemini needs a concrete video mime
    expect(fetchContent).not.toHaveBeenCalled()
  })

  it('does NOT treat a non-Drive URL serving application/octet-stream as video (text path)', async () => {
    const w = wiring({ providerKeyRegistry: new Map<LlmProvider, string>([['google', 'gk']]) })
    const detectType = vi.fn(async () => ({ mediaType: 'application/octet-stream', contentLength: 1000 }))
    const fetchContent = vi.fn(async () => 'TEXT')
    const deps = buildCycleDeps({
      ...w,
      io: {
        listPods: async (_id, opts) => opts.all ? [pod('bin', { url: 'https://cdn.example.com/blob' })] : [],
        fetchContent,
        detectType,
      },
    })
    const { pods } = await deps.getPodsAndFilter('2')
    const bin = pods.find((p) => p.podId === 'bin')!
    expect(bin.mediaUrl).toBeUndefined()           // octet-stream alone is NOT video
    expect(fetchContent).toHaveBeenCalledWith('https://cdn.example.com/blob')
  })

  it('caps the number of video pods marked per cycle (videoPodsPerCycle)', async () => {
    const w = wiring({ providerKeyRegistry: new Map<LlmProvider, string>([['google', 'gk']]) })
    const detectType = vi.fn(async () => ({ mediaType: 'video/mp4', contentLength: 1000 }))
    const fetchContent = vi.fn(async () => '')
    const deps = buildCycleDeps({
      ...w,
      videoPodsPerCycle: 1,
      io: {
        listPods: async (_id, opts) => opts.all ? [pod('v1', { url: 'https://x/a.mp4' }), pod('v2', { url: 'https://x/b.mp4' })] : [],
        fetchContent,
        detectType,
      },
    })
    const { pods } = await deps.getPodsAndFilter('2')
    const marked = pods.filter((p) => p.mediaUrl).length
    expect(marked).toBe(1) // second video pod left unmarked (over the per-cycle cap)
    // The OVER-cap detected video is NOT text-fetched (binary would be sliced into text).
    expect(fetchContent).not.toHaveBeenCalled()
  })

  it('marks contentLength from detection onto the video pod (threaded into ingest)', async () => {
    const w = wiring({ providerKeyRegistry: new Map<LlmProvider, string>([['google', 'gk']]) })
    const deps = buildCycleDeps({
      ...w,
      io: {
        listPods: async (_id, opts) => opts.all ? [pod('vid', { url: 'https://x/c.mp4' })] : [],
        fetchContent: async () => '',
        detectType: async () => ({ mediaType: 'video/mp4', contentLength: 123456 }),
      },
    })
    const { pods } = await deps.getPodsAndFilter('2')
    expect(pods.find((p) => p.podId === 'vid')!.contentLength).toBe(123456)
  })

  it('video cap is GLOBAL per cycle, not per-datanet: resetVideoBudget arms it once', async () => {
    // videoPodsPerCycle=1, two datanets each with a video pod. Without a reset between cycles
    // and with a per-datanet local counter, BOTH would be marked. The closure budget is shared
    // across datanets, so only the FIRST datanet's video is marked until resetVideoBudget runs.
    const w = wiring({ providerKeyRegistry: new Map<LlmProvider, string>([['google', 'gk']]) })
    const deps = buildCycleDeps({
      ...w,
      videoPodsPerCycle: 1,
      io: {
        listPods: async (id, opts) => opts.all ? [pod(`v-${id}`, { url: `https://x/${id}.mp4` })] : [],
        fetchContent: async () => '',
        detectType: async () => ({ mediaType: 'video/mp4', contentLength: 1000 }),
      },
    })
    // Same cycle: datanet A consumes the single video slot; datanet B's video is over-budget.
    const a = await deps.getPodsAndFilter('2')
    const b = await deps.getPodsAndFilter('5')
    expect(a.pods.filter((p) => p.mediaUrl).length).toBe(1)
    expect(b.pods.filter((p) => p.mediaUrl).length).toBe(0) // budget already spent this cycle
    // New cycle: resetVideoBudget re-arms the global budget → the next datanet can mark again.
    deps.resetVideoBudget!()
    const c = await deps.getPodsAndFilter('5')
    expect(c.pods.filter((p) => p.mediaUrl).length).toBe(1)
  })
})

describe('fetchPodContent content-type guard', () => {
  it("returns '' for a video/* response (never slices binary into text)", async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => new Response(new Uint8Array(50), { status: 200, headers: { 'content-type': 'video/mp4' } })) as typeof fetch
    try {
      const { fetchPodContent } = await import('./wiring.js')
      expect(await fetchPodContent('https://x/clip.mp4')).toBe('')
    } finally {
      globalThis.fetch = orig
    }
  })

  it('reads text/* and json responses as before', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => new Response('hello world', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })) as typeof fetch
    try {
      const { fetchPodContent } = await import('./wiring.js')
      expect(await fetchPodContent('https://x/doc.txt')).toBe('hello world')
    } finally {
      globalThis.fetch = orig
    }
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

  it('attaches per-cycle LLM usage to the snapshot AND re-attaches after reflection', async () => {
    h.writeSnapshot.mockClear()
    h.attachSnapshotLlm.mockClear()
    const w = wiring({ learnModel: {} as CycleWiring['model'] })
    const tick = buildTick(w, learnDeps(w), { reloadConfig: () => config })
    await tick()
    // The snapshot written mid-tick carries the llm usage block (cycle-window spend)…
    const written = h.writeSnapshot.mock.calls[0]?.[1] as { llm?: { calls: number } } | undefined
    expect(written?.llm).toBeDefined()
    expect(written!.llm!.calls).toBeGreaterThanOrEqual(0)
    // …and the end-of-tick attach re-writes it so reflection's LLM calls (which run
    // AFTER writeSnapshot) are not wiped unreported by the next cycle's reset.
    expect(h.attachSnapshotLlm).toHaveBeenCalledTimes(1)
    const [, attachCycleId, usage] = h.attachSnapshotLlm.mock.calls[0] as [string, string, { calls: number }]
    expect(typeof attachCycleId).toBe('string')
    expect(usage.calls).toBeGreaterThanOrEqual(0)
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

  it('the default scorer follows config.defaultModel when set (hot, over the env default)', () => {
    // datanet 9 has NO per-datanet model. The env default provider (virtuals) has NO key,
    // but config.defaultModel (usepod) DOES — so the default scorer must resolve via usepod.
    // Before the change it resolves against the env default (virtuals) → skip; after → scorer.
    const cfg = StrategyConfigSchema.parse({
      horizonDays: 7, cadenceHours: 1,
      stake: { lockReppo: 0, lockDurationDays: 7 },
      budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 100, mintGasEthMax: 1 },
      datanets: { '9': { vote: true, mint: false, strictness: 'balanced' } },
      defaultModel: { provider: 'usepod', model: 'deepseek-v3.2' },
      notes: '',
    })
    const w = wiring({
      config: cfg,
      providerKeyRegistry: new Map<LlmProvider, string>([['usepod', 'tok']]), // env default (virtuals) unkeyed
      defaultProvider: 'virtuals',
      defaultModel: 'claude-opus-4-8',
    })
    const r = buildCycleDeps(w).voteScorerFor('9')
    expect('scorer' in r).toBe(true) // resolves via the config default (usepod, keyed)
  })
})

describe('buildCycleDeps mint candidate scorer follows config.defaultModel', () => {
  it('mint candidate scoring resolves the node default via config.defaultModel, not the env default', async () => {
    // The env default provider (virtuals) has NO key — were the mint scorer captured on the
    // env default (w.model) it would resolve against virtuals. config.defaultModel (usepod) IS
    // keyed, so the candidate scorer must resolve LIVE via the config default. We assert by
    // spying resolveModel: it must be called with ('usepod', 'tok', 'deepseek-v3.2').
    const cfg = StrategyConfigSchema.parse({
      horizonDays: 7, cadenceHours: 1,
      stake: { lockReppo: 0, lockDurationDays: 7 },
      budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 100, mintGasEthMax: 1 },
      datanets: { '9': { vote: false, mint: true, strictness: 'balanced' } },
      defaultModel: { provider: 'usepod', model: 'deepseek-v3.2' },
      // deliberation enabled=false → the candidate scorer passes through to the screen scorer
      // (createLlmScorer), whose text path calls generateObjectWithRetry on the resolved model.
      deliberation: { enabled: false, votePanel: false },
      notes: '',
    })
    const w = wiring({
      config: cfg,
      providerKeyRegistry: new Map<LlmProvider, string>([['usepod', 'tok']]), // env default (virtuals) unkeyed
      defaultProvider: 'virtuals',
      defaultModel: 'claude-opus-4-8',
    })
    h.resolveModel.mockClear()
    h.generateObjectWithRetry.mockClear()
    const deps = buildCycleDeps(w)
    const rubric = {
      datanetId: '9', subnetUuid: 'u', canVote: false, canMint: true, voteRubric: '', mintSpec: 'spec', subnetDescription: '',
      economics: { accessFeeReppo: 0, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'REPPO' },
    } as unknown as DatanetRubric
    const candidate = { canonicalKey: 'k1', podName: 'n', podDescription: 'd', dataset: { a: 1 }, sourceUrl: 'https://x/1' } as unknown as CandidatePod
    await deps.candidateScorer.scoreCandidate(candidate, rubric)
    // resolveModel was driven by the LIVE effective default (config.defaultModel = usepod),
    // NOT the env default (virtuals). Before the change it captured w.model (virtuals).
    expect(h.resolveModel).toHaveBeenCalledWith('usepod', 'tok', 'deepseek-v3.2')
    expect(h.resolveModel).not.toHaveBeenCalledWith('virtuals', expect.anything(), expect.anything())
    expect(h.generateObjectWithRetry).toHaveBeenCalled() // a model WAS resolved + scored
  })

  it('mint screen prompts never render the vote-economics block even when currentYield is attached', async () => {
    // The cycle attaches economics.currentYield onto the PROCESS-CACHED rubric object before
    // vote scoring; mint scoring runs later in the same datanet iteration with the SAME object.
    // Yield is a where-to-vote signal — the mint prompt must never render it.
    const cfg = StrategyConfigSchema.parse({
      horizonDays: 7, cadenceHours: 1,
      stake: { lockReppo: 0, lockDurationDays: 7 },
      budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 100, mintGasEthMax: 1 },
      datanets: { '9': { vote: false, mint: true, strictness: 'balanced' } },
      defaultModel: { provider: 'usepod', model: 'deepseek-v3.2' },
      deliberation: { enabled: false, votePanel: false },
      notes: '',
    })
    const w = wiring({
      config: cfg,
      providerKeyRegistry: new Map<LlmProvider, string>([['usepod', 'tok']]),
      defaultProvider: 'virtuals',
      defaultModel: 'claude-opus-4-8',
    })
    h.generateObjectWithRetry.mockClear()
    const deps = buildCycleDeps(w)
    const rubric = {
      datanetId: '9', subnetUuid: 'u', canVote: false, canMint: true, voteRubric: '', mintSpec: 'spec', subnetDescription: '',
      economics: {
        accessFeeReppo: 0, emissionsPerEpochReppo: 500, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'REPPO',
        currentYield: { datanetId: '9', emissionsPerEpochReppo: 500, epoch: 42, epochVoteVolume: 2_000_000, yieldPerVote: 0.00025, uncontested: false },
      },
    } as unknown as DatanetRubric
    const candidate = { canonicalKey: 'k1', podName: 'n', podDescription: 'd', dataset: { a: 1 }, sourceUrl: 'https://x/1' } as unknown as CandidatePod
    await deps.candidateScorer.scoreCandidate(candidate, rubric)
    expect(h.generateObjectWithRetry).toHaveBeenCalled()
    // generateObjectWithRetry(model, schema, system, { prompt }) — the block must appear nowhere.
    const [, , system, gen] = h.generateObjectWithRetry.mock.calls[0] as unknown as [unknown, unknown, string, { prompt?: string }]
    expect(system).not.toContain('## Datanet economics')
    expect(gen.prompt ?? '').not.toContain('## Datanet economics')
    // The strip must be a clone at the mint boundary — the shared rubric object stays intact
    // for the vote path.
    expect(rubric.economics.currentYield).toBeDefined()
  })
})
