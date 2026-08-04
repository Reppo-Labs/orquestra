// src/adapter/sherwood/index.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createSherwoodAdapter, parseSherwoodParams } from './index.js'
import type { PoolInfo } from './pools.js'
import type { PoolMetrics } from './metrics.js'
import type { MorphoMarket } from './morpho.js'
import type { Proposal } from './proposal.js'
import type { DatanetRubric } from '../../rubric/types.js'

const rubric = { name: 'Sherwood Trading Strategies', goal: 'g', publisherSpec: 'template', voterRubric: 'v', canMint: true } as DatanetRubric

const pools: PoolInfo[] = [
  { name: 'WOOD / WETH 0.3%', address: '0xpool1', dex: 'sushiswap-robinhood', reserveUsd: 500_000, volumeUsd24h: 1_000_000 },
  { name: 'DUST / WETH', address: '0xdust', dex: 'sushiswap-robinhood', reserveUsd: 500, volumeUsd24h: 10 },
]

const healthyMetrics: PoolMetrics = {
  address: '0xpool1',
  sigma1d: 0.05,
  volAvg7d: 900_000,
  volAvg14d: 1_000_000,
  volTrendRatio: 0.9,
  returns: 14,
  asOf: '2026-08-03T00:00:00.000Z',
}

const measure = (m: Record<string, PoolMetrics> = { '0xpool1': healthyMetrics }) =>
  async (addrs: string[]): Promise<Map<string, PoolMetrics>> =>
    new Map(addrs.filter((a) => a in m).map((a) => [a, m[a]]))

const proposal: Proposal = {
  title: 'WOOD/WETH CL LP',
  strategy_type: 'cl_lp',
  pool_address: '0xpool1',
  vault_asset: 'WOOD',
  thesis: 'Fee capture on the deepest WOOD pool.',
  entry_rule: 'enter when 7d avg volume / TVL exceeds 0.5',
  exit_rule: 'unwind when pool TVL falls below 50% of entry TVL',
  rerange_rule: 'rerange when price exits 80% of the range',
  band_sigma_mult: 1,
  exit_band_mult: 2,
  capital_share_of_tvl: 0.03,
  self_score: 8,
}

const gen = async () => ({ strategies: [proposal] })
const lend = async (): Promise<MorphoMarket[]> => []

const usdgMarket: MorphoMarket = {
  marketId: '0xmkt-tsla',
  collateralSymbol: 'TSLA',
  collateralName: 'Tesla (Robinhood Tokenized Stock)',
  collateralAddress: '0xtsla',
  loanSymbol: 'USDG',
  loanAddress: '0xusdg',
  lltv: 0.77,
  borrowApy: 0.016,
  supplyApy: 0.011,
  liquidityUsd: 50_000,
  borrowedUsd: 12,
}

/** Default deps for a healthy cycle. */
const base = (over: Parameters<typeof createSherwoodAdapter>[0] = {}) =>
  createSherwoodAdapter({ fetchLendingMarkets: lend, fetchPools: async () => pools, fetchMetrics: measure(), generate: gen, ...over })

describe('parseSherwoodParams', () => {
  it('accepts well-typed fields and drops wrong-typed ones', () => {
    expect(parseSherwoodParams({ focus: 'f', topN: 2, minSelfScore: 9, minPoolLiquidityUsd: 50_000, brief: 5 as unknown as string }))
      .toEqual({ focus: 'f', topN: 2, minSelfScore: 9, minPoolLiquidityUsd: 50_000 })
    expect(parseSherwoodParams(undefined)).toEqual({})
  })
})

describe('createSherwoodAdapter', () => {
  it('has id "sherwood"', () => {
    expect(base().id).toBe('sherwood')
  })

  it('discover() fetches and MEASURES pools, synthesizes proposals, returns candidates', async () => {
    const fetchPools = vi.fn(async () => pools)
    const fetchMetrics = vi.fn(measure())
    const cands = await base({ fetchPools, fetchMetrics }).discover({ datanetId: '3', rubric, topN: 3 })
    expect(cands).toHaveLength(1)
    expect(cands[0].podName).toBe('WOOD/WETH CL LP')
    expect(fetchPools).toHaveBeenCalledOnce()
    expect(fetchMetrics).toHaveBeenCalledOnce()
  })

  it('every number in the emitted dataset is derived, with its expression and evidence', async () => {
    const cands = await base().discover({ datanetId: '3', rubric, topN: 3 })
    const d = cands[0].dataset as Record<string, any>
    // band = 1.0 × σ(5%) — not a number the model typed
    expect(d.band.value_pct).toBeCloseTo(5, 3)
    expect(d.band.expr).toContain('σ_1d')
    expect(d.exit_band.value_pct).toBeCloseTo(10, 3)
    // capital = 3% × TVL($500k)
    expect(d.capital_range_usd.max).toBe(15_000)
    // the venue is cited by address, and capacity is asserted
    expect(d.venue_pool_address).toBe('0xpool1')
    expect(d.capacity.pool_tvl_usd).toBe(500_000)
    expect(d.capacity.est_exit_slippage_bps).toBeGreaterThan(0)
    // evidence carries sources and timestamps
    expect(d.evidence.length).toBeGreaterThan(3)
    expect(d.evidence.every((e: { source: string; as_of: string }) => e.source && e.as_of)).toBe(true)
    // the non-decay condition is appended to entry unconditionally
    expect(d.entry_rule).toContain('7d avg daily volume >= 0.6 x 14d avg daily volume')
  })

  it('drops a proposal citing a pool address that is not in the live set', async () => {
    const cands = await base({
      generate: async () => ({ strategies: [{ ...proposal, pool_address: '0xdoesnotexist' }] }),
    }).discover({ datanetId: '3', rubric, topN: 3 })
    expect(cands).toEqual([])
  })

  it('does not offer a decaying venue — the entry rule the original lacked', async () => {
    let called = false
    const decaying: PoolMetrics = { ...healthyMetrics, volAvg7d: 300_000, volAvg14d: 1_000_000, volTrendRatio: 0.3 }
    const cands = await base({
      fetchMetrics: measure({ '0xpool1': decaying }),
      generate: async () => { called = true; return { strategies: [proposal] } },
    }).discover({ datanetId: '3', rubric, topN: 3 })
    expect(cands).toEqual([])
    expect(called).toBe(false) // never even offered to the model
  })

  it('does not offer a pool it could not measure — no σ means no band input', async () => {
    let called = false
    const cands = await base({
      fetchMetrics: measure({}),
      generate: async () => { called = true; return { strategies: [proposal] } },
    }).discover({ datanetId: '3', rubric, topN: 3 })
    expect(cands).toEqual([])
    expect(called).toBe(false)
  })

  it('filters dust pools below minPoolLiquidityUsd out of the prompt', async () => {
    const seen: string[] = []
    await base({
      generate: async ({ prompt }) => { seen.push(prompt); return { strategies: [proposal] } },
    }).discover({ datanetId: '3', rubric, topN: 3 })
    expect(seen[0]).toContain('WOOD / WETH 0.3%')
    expect(seen[0]).not.toContain('DUST / WETH')
  })

  it('the prompt states the measured inputs and the depth cap, not just the pool', async () => {
    const seen: string[] = []
    await base({
      generate: async ({ prompt }) => { seen.push(prompt); return { strategies: [proposal] } },
    }).discover({ datanetId: '3', rubric, topN: 3 })
    expect(seen[0]).toContain('pool_address 0xpool1')
    expect(seen[0]).toContain('σ_1d 5.00%')
    expect(seen[0]).toContain('7d avg vol $900,000')
    expect(seen[0]).toContain('max deployable at the 8.00% depth cap: $40,000')
  })

  it('all pools below the liquidity floor → [] without calling the model', async () => {
    let called = false
    const cands = await base({
      fetchPools: async () => [pools[1]],
      generate: async () => { called = true; return { strategies: [proposal] } },
    }).discover({ datanetId: '3', rubric, topN: 3 })
    expect(cands).toEqual([])
    expect(called).toBe(false)
  })

  it('applies the novelty backstop against existingPodNames', async () => {
    const cands = await base().discover({ datanetId: '3', rubric, topN: 3, existingPodNames: ['WOOD/WETH CL LP'] })
    expect(cands).toEqual([])
  })

  it('feeds existingPodNames into the synthesis prompt (steer, not just filter)', async () => {
    const seen: string[] = []
    await base({
      generate: async ({ prompt }) => { seen.push(prompt); return { strategies: [proposal] } },
    }).discover({ datanetId: '3', rubric, topN: 3, existingPodNames: ['Old Strategy Pod'] })
    expect(seen[0]).toContain('Already minted on this datanet')
    expect(seen[0]).toContain('- Old Strategy Pod')
  })

  it('pool fetch failure → [] this cycle, no throw into the cycle', async () => {
    const a = base({ fetchPools: async () => { throw new Error('429') } })
    await expect(a.discover({ datanetId: '3', rubric, topN: 3 })).resolves.toEqual([])
  })

  it('metrics fetch failure → [] this cycle rather than defaulted inputs', async () => {
    const a = base({ fetchMetrics: async () => { throw new Error('429') } })
    await expect(a.discover({ datanetId: '3', rubric, topN: 3 })).resolves.toEqual([])
  })

  it('reuses the last successful snapshot within minFetchIntervalMs (still mints)', async () => {
    let clock = 1_000_000
    const fetchPools = vi.fn(async () => pools)
    const fetchMetrics = vi.fn(measure())
    const a = base({ fetchPools, fetchMetrics, minFetchIntervalMs: 30 * 60_000, now: () => clock })
    await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(fetchPools).toHaveBeenCalledTimes(1)
    clock += 5 * 60_000 // within the guard — cached snapshot, no refetch
    const second = await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(fetchPools).toHaveBeenCalledTimes(1)
    expect(second).toHaveLength(1) // unlike a skip, cached data still produces candidates
    clock += 30 * 60_000 // past the pool guard — but daily candles have not aged
    await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(fetchPools).toHaveBeenCalledTimes(2)
    expect(fetchMetrics).toHaveBeenCalledTimes(1) // measurements keep their own 6h TTL
  })

  it('stamps evidence with the FETCH time, not the cycle time', async () => {
    let clock = 1_000_000
    const a = base({ minFetchIntervalMs: 30 * 60_000, now: () => clock })
    await a.discover({ datanetId: '3', rubric, topN: 3 })
    clock += 20 * 60_000 // still inside the throttle: pools are a 20-min-old snapshot
    const cands = await a.discover({ datanetId: '3', rubric, topN: 3 })
    const ev = (cands[0].dataset as Record<string, any>).evidence as { claim: string; as_of: string }[]
    const tvl = ev.find((e) => e.claim === 'pool TVL')!
    // the reading is 20 minutes old and must say so, not restate itself as now
    expect(tvl.as_of).toBe(new Date(1_000_000).toISOString())
  })

  it('re-measures once the metrics TTL has passed', async () => {
    let clock = 1_000_000
    const fetchMetrics = vi.fn(measure())
    const a = base({ fetchMetrics, minFetchIntervalMs: 30 * 60_000, now: () => clock })
    await a.discover({ datanetId: '3', rubric, topN: 3 })
    clock += 7 * 60 * 60_000 // past the 6h candle TTL
    await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(fetchMetrics).toHaveBeenCalledTimes(2)
  })

  it('measures only a few pools per cycle and accumulates coverage across cycles', async () => {
    // Live, ten paced OHLCV calls took 173s — a full sweep would stall a cycle.
    const many: PoolInfo[] = Array.from({ length: 5 }, (_, i) => ({
      name: `T${i} / WETH 0.3%`, address: `0xp${i}`, dex: 'sushiswap-robinhood',
      reserveUsd: 1_000_000 - i, volumeUsd24h: 100_000,
    }))
    const all = Object.fromEntries(many.map((p) => [p.address, { ...healthyMetrics, address: p.address }]))
    const batches: string[][] = []
    const fetchMetrics = vi.fn(async (addrs: string[]) => {
      batches.push(addrs)
      return measure(all)(addrs)
    })
    const offered: number[] = []
    const a = base({
      fetchPools: async () => many,
      fetchMetrics,
      generate: async ({ prompt }) => {
        offered.push((prompt.match(/— pool_address /g) ?? []).length) // venue lines only
        return { strategies: [] }
      },
    })
    await a.discover({ datanetId: '3', rubric, topN: 3 })
    await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(batches[0]).toHaveLength(3) // capped per cycle
    expect(batches[1]).toHaveLength(2) // only the still-unmeasured remainder
    expect(offered).toEqual([3, 5]) // coverage grows; measured venues offered meanwhile
  })

  it('a FAILED fetch does not arm the throttle — next cycle retries', async () => {
    let clock = 1_000_000
    let calls = 0
    const fetchPools = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('429')
      return pools
    })
    const a = base({ fetchPools, minFetchIntervalMs: 30 * 60_000, now: () => clock })
    expect(await a.discover({ datanetId: '3', rubric, topN: 3 })).toEqual([])
    clock += 60_000 // 1 min later — a throttled adapter would skip; a retried one fetches
    const cands = await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(cands).toHaveLength(1)
    expect(fetchPools).toHaveBeenCalledTimes(2)
  })

  it('operator adapterParams tighten the quality gate', async () => {
    const cands = await base().discover({ datanetId: '3', rubric, topN: 3, strategy: { minSelfScore: 9 } })
    expect(cands).toEqual([]) // self_score 8 < gate 9
  })

  const borrowLeg = {
    market_id: '0xmkt-tsla',
    collateral_symbol: 'TSLA',
    borrowed_asset: 'USDG',
    ltv_frac_of_lltv: 0.65,
    exit_ltv_frac_of_lltv: 0.85,
  }

  it('rejects pairs whose borrowed asset is not borrowable per live lending data', async () => {
    // Live data says only USDG is borrowable — this one borrows WETH.
    const cands = await base({
      fetchLendingMarkets: async () => [usdgMarket],
      generate: async () => ({ strategies: [{ ...proposal, borrow: { ...borrowLeg, borrowed_asset: 'WETH' } }] }),
    }).discover({ datanetId: '3', rubric, topN: 3 })
    expect(cands).toEqual([])
  })

  it('accepts a pair that resolves to a live market, and cites it by id', async () => {
    const seen: string[] = []
    const cands = await base({
      fetchLendingMarkets: async () => [usdgMarket],
      generate: async ({ prompt }) => {
        seen.push(prompt)
        return { strategies: [{ ...proposal, borrow: borrowLeg }] }
      },
    }).discover({ datanetId: '3', rubric, topN: 3 })
    expect(cands).toHaveLength(1)
    const d = cands[0].dataset as Record<string, any>
    expect(d.pair.market_id).toBe('0xmkt-tsla')
    expect(d.pair.borrow_venue).toBe('morpho-blue')
    expect(d.leverage.target_ltv_pct).toBeCloseTo(0.65 * 0.77 * 100, 2)
    expect(d.capacity.intended_borrow_usd).toBeGreaterThan(0)
    expect(seen[0]).toContain('Live Morpho Blue lending markets')
    expect(seen[0]).toContain('market_id 0xmkt-tsla')
  })

  it('rejects a borrow the resolved market cannot fund', async () => {
    const thin: MorphoMarket = { ...usdgMarket, liquidityUsd: 339 }
    const cands = await base({
      fetchLendingMarkets: async () => [thin],
      generate: async () => ({ strategies: [{ ...proposal, borrow: borrowLeg }] }),
    }).discover({ datanetId: '3', rubric, topN: 3 })
    expect(cands).toEqual([])
  })

  it('lending fetch failure drops PAIR strategies (no market resolves) but unlevered ones still flow', async () => {
    const down = async (): Promise<MorphoMarket[]> => { throw new Error('morpho down') }
    const paired = await base({
      fetchLendingMarkets: down,
      generate: async () => ({ strategies: [{ ...proposal, borrow: borrowLeg }] }),
    }).discover({ datanetId: '3', rubric, topN: 3 })
    expect(paired).toEqual([]) // resolve-or-refuse: no data, no leg

    const unlevered = await base({ fetchLendingMarkets: down }).discover({ datanetId: '3', rubric, topN: 3 })
    expect(unlevered).toHaveLength(1)
  })
})
