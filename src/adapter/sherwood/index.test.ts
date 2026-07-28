// src/adapter/sherwood/index.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createSherwoodAdapter, parseSherwoodParams } from './index.js'
import type { PoolInfo } from './pools.js'
import type { Proposal } from './proposal.js'
import type { DatanetRubric } from '../../rubric/types.js'

const rubric = { name: 'Sherwood Trading Strategies', goal: 'g', publisherSpec: 'template', voterRubric: 'v', canMint: true } as DatanetRubric

const pools: PoolInfo[] = [
  { name: 'WOOD / WETH 0.3%', address: '0xpool1', dex: 'sushiswap-robinhood', reserveUsd: 500_000, volumeUsd24h: 1_000_000 },
  { name: 'DUST / WETH', address: '0xdust', dex: 'sushiswap-robinhood', reserveUsd: 500, volumeUsd24h: 10 },
]

const proposal: Proposal = {
  title: 'WOOD/WETH CL LP ±5%',
  strategy_type: 'cl_lp',
  vault_asset: 'WOOD',
  venue: 'SushiSwap',
  pair: { borrowed_asset: 'WETH', borrow_venue: 'Lighter' },
  thesis: 'Fee capture.',
  entry_rule: 'enter when 24h volume / TVL exceeds 0.5',
  exit_rule: 'unwind when pool TVL drops below $250000',
  rerange_rule: 'rerange to ±5% when price exits 80% of the range',
  max_drawdown_bps: 800,
  expected_roe_bps: 2500,
  capital_range_usd: { min: 10_000, max: 100_000 },
  self_score: 8,
}

const gen = async () => ({ strategies: [proposal] })
const lend = async () => []

describe('parseSherwoodParams', () => {
  it('accepts well-typed fields and drops wrong-typed ones', () => {
    expect(parseSherwoodParams({ focus: 'f', topN: 2, minSelfScore: 9, minPoolLiquidityUsd: 50_000, brief: 5 as unknown as string }))
      .toEqual({ focus: 'f', topN: 2, minSelfScore: 9, minPoolLiquidityUsd: 50_000 })
    expect(parseSherwoodParams(undefined)).toEqual({})
  })
})

describe('createSherwoodAdapter', () => {
  it('has id "sherwood"', () => {
    expect(createSherwoodAdapter({ fetchLendingMarkets: lend, fetchPools: async () => pools, generate: gen }).id).toBe('sherwood')
  })

  it('discover() fetches pools, synthesizes proposals, returns candidates', async () => {
    const fetchPools = vi.fn(async () => pools)
    const a = createSherwoodAdapter({ fetchLendingMarkets: lend, fetchPools, generate: gen })
    const cands = await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(cands).toHaveLength(1)
    expect(cands[0].podName).toBe('WOOD/WETH CL LP ±5%')
    expect(fetchPools).toHaveBeenCalledOnce()
  })

  it('filters dust pools below minPoolLiquidityUsd out of the prompt', async () => {
    const seen: string[] = []
    const a = createSherwoodAdapter({ fetchLendingMarkets: lend,
      fetchPools: async () => pools,
      generate: async ({ prompt }) => { seen.push(prompt); return { strategies: [proposal] } },
    })
    await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(seen[0]).toContain('WOOD / WETH 0.3%')
    expect(seen[0]).not.toContain('DUST / WETH')
  })

  it('all pools below the liquidity floor → [] without calling the model', async () => {
    let called = false
    const a = createSherwoodAdapter({ fetchLendingMarkets: lend,
      fetchPools: async () => [pools[1]],
      generate: async () => { called = true; return { strategies: [proposal] } },
    })
    expect(await a.discover({ datanetId: '3', rubric, topN: 3 })).toEqual([])
    expect(called).toBe(false)
  })

  it('applies the novelty backstop against existingPodNames', async () => {
    const a = createSherwoodAdapter({ fetchLendingMarkets: lend, fetchPools: async () => pools, generate: gen })
    const cands = await a.discover({ datanetId: '3', rubric, topN: 3, existingPodNames: ['WOOD/WETH CL LP ±5%'] })
    expect(cands).toEqual([])
  })

  it('pool fetch failure → [] this cycle, no throw into the cycle', async () => {
    const a = createSherwoodAdapter({ fetchLendingMarkets: lend, fetchPools: async () => { throw new Error('429') }, generate: gen })
    await expect(a.discover({ datanetId: '3', rubric, topN: 3 })).resolves.toEqual([])
  })

  it('reuses the last successful pool snapshot within minFetchIntervalMs (still mints)', async () => {
    let clock = 1_000_000
    const fetchPools = vi.fn(async () => pools)
    const a = createSherwoodAdapter({ fetchLendingMarkets: lend, fetchPools, generate: gen, minFetchIntervalMs: 30 * 60_000, now: () => clock })
    await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(fetchPools).toHaveBeenCalledTimes(1)
    clock += 5 * 60_000 // within the guard — cached snapshot, no refetch
    const second = await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(fetchPools).toHaveBeenCalledTimes(1)
    expect(second).toHaveLength(1) // unlike a skip, cached pools still produce candidates
    clock += 30 * 60_000 // past the guard
    await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(fetchPools).toHaveBeenCalledTimes(2)
  })

  it('a FAILED fetch does not arm the throttle — next cycle retries', async () => {
    let clock = 1_000_000
    let calls = 0
    const fetchPools = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('429')
      return pools
    })
    const a = createSherwoodAdapter({ fetchLendingMarkets: lend, fetchPools, generate: gen, minFetchIntervalMs: 30 * 60_000, now: () => clock })
    expect(await a.discover({ datanetId: '3', rubric, topN: 3 })).toEqual([])
    clock += 60_000 // 1 min later — a throttled adapter would skip; a retried one fetches
    const cands = await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(cands).toHaveLength(1)
    expect(fetchPools).toHaveBeenCalledTimes(2)
  })

  it('operator adapterParams tighten the quality gate', async () => {
    const a = createSherwoodAdapter({ fetchLendingMarkets: lend, fetchPools: async () => pools, generate: gen })
    const cands = await a.discover({ datanetId: '3', rubric, topN: 3, strategy: { minSelfScore: 9 } })
    expect(cands).toEqual([]) // self_score 8 < gate 9
  })

  const usdgMarket = {
    collateralSymbol: 'TSLA', collateralName: 'Tesla (Robinhood Tokenized Stock)', loanSymbol: 'USDG',
    lltv: 0.77, borrowApy: 0.016, liquidityUsd: 50_000, borrowedUsd: 12,
  }

  it('rejects pairs whose borrowed asset is not borrowable per live lending data', async () => {
    // Live data says only USDG is borrowable — the fixture borrows WETH.
    const a = createSherwoodAdapter({
      fetchLendingMarkets: async () => [usdgMarket],
      fetchPools: async () => pools,
      generate: gen,
    })
    expect(await a.discover({ datanetId: '3', rubric, topN: 3 })).toEqual([])
  })

  it('accepts pairs borrowing a live loan asset and surfaces the Morpho section in the prompt', async () => {
    const seen: string[] = []
    const a = createSherwoodAdapter({
      fetchLendingMarkets: async () => [usdgMarket],
      fetchPools: async () => pools,
      generate: async ({ prompt }) => {
        seen.push(prompt)
        return { strategies: [{ ...proposal, pair: { borrowed_asset: 'USDG', borrow_venue: 'Morpho' } }] }
      },
    })
    const cands = await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(cands).toHaveLength(1)
    expect(seen[0]).toContain('Live Morpho Blue lending markets')
    expect(seen[0]).toContain('collateral TSLA → borrow USDG — LLTV 77.0%')
  })

  it('lending fetch failure degrades gracefully — proposals still flow, gate off', async () => {
    const a = createSherwoodAdapter({
      fetchLendingMarkets: async () => { throw new Error('morpho down') },
      fetchPools: async () => pools,
      generate: gen,
    })
    const cands = await a.discover({ datanetId: '3', rubric, topN: 3 })
    expect(cands).toHaveLength(1) // WETH borrow passes: no data, no gate
  })
})
