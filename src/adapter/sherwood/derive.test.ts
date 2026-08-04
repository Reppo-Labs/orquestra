// src/adapter/sherwood/derive.test.ts
// The cases below are the actual defects from the reviewed NVDA strategy,
// pinned as tests: a ±3% band on a 3.85σ asset, a $350k position in an $820k
// pool, and a borrow sized without ever asking whether the market could fill it.
import { describe, it, expect } from 'vitest'
import {
  deriveStrategy,
  venueRejectReason,
  feeApr,
  exitSlippageBps,
  MAX_POOL_SHARE,
  type Venue,
  type PolicyChoice,
} from './derive.js'
import type { PoolInfo } from './pools.js'
import type { PoolMetrics } from './metrics.js'
import type { MorphoMarket } from './morpho.js'

const AS_OF = '2026-08-04T00:00:00.000Z'
const CANDLE_AS_OF = '2026-08-03T00:00:00.000Z'

// The real venue, as measured: $820k TVL, 3.85% realized daily vol, 7d avg
// volume $3.87M against a 14d avg of $6.5M.
const pool: PoolInfo = {
  name: 'nvda / USDG 0.05%',
  address: '0xpool-nvda',
  dex: 'uniswap-v3-robinhood',
  reserveUsd: 820_000,
  volumeUsd24h: 1_320_000,
}
const metrics: PoolMetrics = {
  address: '0xpool-nvda',
  sigma1d: 0.0385,
  volAvg7d: 3_870_000,
  volAvg14d: 6_500_000,
  volTrendRatio: 3_870_000 / 6_500_000, // 0.595 — below the 0.6 floor
  returns: 14,
  asOf: CANDLE_AS_OF,
}
/** Same venue but not decaying — the baseline most tests run on. */
const healthy: Venue = {
  pool,
  metrics: { ...metrics, volAvg14d: 4_300_000, volTrendRatio: 3_870_000 / 4_300_000 },
}

const market: MorphoMarket = {
  marketId: '0x0309c02d',
  collateralSymbol: 'spUSDG',
  collateralName: 'Spark Savings USDG',
  collateralAddress: '0xde770c84',
  loanSymbol: 'USDG',
  loanAddress: '0xusdg',
  lltv: 0.915,
  borrowApy: 0.0303,
  supplyApy: 0.0228,
  liquidityUsd: 1_194_028,
  borrowedUsd: 12_794_469,
}

const policy: PolicyChoice = { bandSigmaMult: 1, exitBandMult: 2, capitalShareOfTvl: 0.03 }

const derive = (over: Partial<Parameters<typeof deriveStrategy>[0]> = {}) =>
  deriveStrategy({ strategyType: 'cl_lp', venue: healthy, policy, asOf: AS_OF, ...over })

describe('venueRejectReason', () => {
  it('refuses a decaying venue at ENTRY, not only at exit', () => {
    // 7d avg is 59.5% of the 14d avg — the monotonic collapse the original
    // strategy had no entry rule for.
    expect(venueRejectReason({ pool, metrics })).toMatch(/decaying/)
  })
  it('accepts a venue whose recent week holds up', () => {
    expect(venueRejectReason(healthy)).toBeNull()
  })
  it('refuses a venue with no measurable volatility rather than assuming one', () => {
    expect(venueRejectReason({ pool, metrics: { ...healthy.metrics, sigma1d: 0 } })).toMatch(/volatility/)
  })
})

describe('feeApr', () => {
  it('is trailing volume × fee tier / TVL, annualized', () => {
    expect(feeApr(pool, healthy.metrics)).toBeCloseTo(((3_870_000 * 0.0005) / 820_000) * 365, 6)
  })
  it('undefined without a fee tier — fee income is then unmeasurable', () => {
    expect(feeApr({ ...pool, name: 'nvda / USDG' }, healthy.metrics)).toBeUndefined()
  })
})

describe('exitSlippageBps', () => {
  it('grows with the share of the pool you are exiting into', () => {
    const small = exitSlippageBps(24_600, 820_000, 0.0005)
    const huge = exitSlippageBps(350_000, 820_000, 0.0005) // the original's 43% share
    expect(huge).toBeGreaterThan(small * 10)
    expect(huge).toBeGreaterThan(2_000) // >20% round-trip cost, unmissable
  })
})

describe('deriveStrategy — bands are functions, not constants', () => {
  it('derives the band from the asset σ instead of a hardcoded ±3%', () => {
    const r = derive()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 1.0 × σ = 3.85%, not the 3% the original hardcoded
    expect(r.derived.bandPct).toBeCloseTo(0.0385, 6)
    expect(r.derived.exitPct).toBeCloseTo(0.077, 6)
    expect(r.derived.derivation.band_pct).toContain('σ_1d')
    expect(r.derived.derivation.band_pct).toContain('3.85%')
    expect(r.derived.derivation.exit_pct).toContain('7.70%')
  })

  it('the same multipliers move with the asset — portability the constants lacked', () => {
    const calm = derive({ venue: { ...healthy, metrics: { ...healthy.metrics, sigma1d: 0.008 } } })
    expect(calm.ok).toBe(true)
    if (!calm.ok) return
    expect(calm.derived.bandPct).toBeCloseTo(0.008, 6)
  })

  it('derives LTV from the market LLTV and names the market in the expression', () => {
    const r = derive({ market, policy: { ...policy, ltvFracOfLltv: 0.65, exitLtvFracOfLltv: 0.85 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.derived.targetLtv).toBeCloseTo(0.65 * 0.915, 6)
    expect(r.derived.exitLtv).toBeCloseTo(0.85 * 0.915, 6)
    expect(r.derived.derivation.target_ltv).toContain('0x0309c02d')
  })
})

describe('deriveStrategy — capacity', () => {
  it('sizes capital from measured depth', () => {
    const r = derive()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.derived.capitalMaxUsd).toBeCloseTo(0.03 * 820_000, 6)
    expect(r.derived.capacity.pool_tvl_usd).toBe(820_000)
    expect(r.derived.capacity.est_exit_slippage_bps).toBeGreaterThan(0)
  })

  it('refuses a position that would BE the pool (the $350k-in-$820k case)', () => {
    const r = derive({ policy: { ...policy, capitalShareOfTvl: 0.43 } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/exceeds the 8\.00% depth cap/)
    expect(MAX_POOL_SHARE).toBe(0.08)
  })

  it('refuses a borrow the market cannot fund — the question never asked', () => {
    // A thin market, as the stock-collateral markets on 4663 actually are.
    const thin: MorphoMarket = { ...market, liquidityUsd: 339, marketId: '0xthin' }
    const r = derive({ market: thin, policy: { ...policy, ltvFracOfLltv: 0.65 } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/exceeds 50\.00% of lendable liquidity \$339/)
    expect(r.reason).toContain('0xthin')
  })

  it('allows the same borrow against a market that is actually deep', () => {
    const r = derive({ market, policy: { ...policy, ltvFracOfLltv: 0.65 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.derived.capacity.intended_borrow_usd).toBe(Math.round(0.65 * 0.915 * 0.03 * 820_000))
    expect(r.derived.capacity.borrowable_liquidity_usd).toBe(1_194_028)
    expect(r.derived.capacity.borrow_share_of_lendable!).toBeLessThan(0.5)
  })
})

describe('deriveStrategy — returns must have a basis', () => {
  it('derives ROE from fee income net of borrow cost, showing the expression', () => {
    const r = derive({ market, policy: { ...policy, ltvFracOfLltv: 0.65 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const lev = 1 + 0.65 * 0.915
    const gross = ((3_870_000 * 0.0005) / 820_000) * 365 * lev
    const net = gross - 0.0303 * 0.65 * 0.915
    expect(r.derived.expectedRoeBps).toBe(Math.round(net * 10_000))
    expect(r.derived.derivation.expected_roe).toContain('borrow APY')
    expect(r.derived.derivation.fee_apr).toContain('vol7d')
  })

  it('ships the ROE inputs as NUMBERS so the figure is reconstructible without parsing prose', () => {
    const r = derive({ market, policy: { ...policy, ltvFracOfLltv: 0.65 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const i = r.derived.expectedRoeInputs
    expect(i.basis).toBe('pool_fee_apr')
    expect(i.borrow_apr_frac).toBe(0.0303)
    expect(i.target_ltv_frac).toBeCloseTo(0.65 * 0.915, 6)
    // the published bps must reproduce from the published inputs alone
    expect(i.gross_apr_frac - i.borrow_cost_frac).toBeCloseTo(i.net_apr_frac, 6)
    expect(Math.round(i.net_apr_frac * 10_000)).toBe(r.derived.expectedRoeBps)
    expect(i.fee_apr_frac! * i.leverage).toBeCloseTo(i.gross_apr_frac, 4)
  })

  it('refuses a strategy type whose return cannot be measured', () => {
    const r = derive({ strategyType: 'portfolio' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/no measurable yield basis/)
  })

  it('refuses when the derived return does not cover its own borrow', () => {
    const dear: MorphoMarket = { ...market, borrowApy: 5 }
    const r = derive({ market: dear, policy: { ...policy, ltvFracOfLltv: 0.65 } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/does not pay for its own borrow/)
  })

  it('lending_supply derives from the market supply APY', () => {
    const r = derive({ strategyType: 'lending_supply', market })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.derived.expectedRoeBps).toBe(Math.round(0.0228 * 10_000))
    expect(r.derived.derivation.gross_apr).toContain('supply APY')
  })
})

describe('deriveStrategy — leverage safety', () => {
  it('refuses an exit LTV at or past liquidation', () => {
    const r = derive({ market, policy: { ...policy, ltvFracOfLltv: 0.8, exitLtvFracOfLltv: 1.0 } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/past liquidation LLTV/)
  })

  it('refuses an exit LTV that is not above the target', () => {
    const r = derive({ market, policy: { ...policy, ltvFracOfLltv: 0.7, exitLtvFracOfLltv: 0.7 } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/no room to de-risk/)
  })

  it('drawdown is the tighter of the band exit and the LTV stop', () => {
    const r = derive({ market, policy: { ...policy, ltvFracOfLltv: 0.65, exitLtvFracOfLltv: 0.85 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ltvStop = 1 - 0.65 / 0.85
    expect(r.derived.maxDrawdownBps).toBe(Math.round(Math.min(0.077, ltvStop) * 10_000))
    expect(r.derived.derivation.max_drawdown).toContain('min(')
  })
})

describe('deriveStrategy — evidence', () => {
  it('stamps every measured value with a resolvable source and an as_of', () => {
    const r = derive({ market })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ev = r.derived.evidence
    expect(ev.every((e) => e.source.length > 0 && e.as_of.length > 0)).toBe(true)
    const tvl = ev.find((e) => e.claim === 'pool TVL')!
    expect(tvl.source).toBe('geckoterminal:pool:0xpool-nvda')
    expect(tvl.as_of).toBe(AS_OF)
    // candle-derived values carry the CANDLE's timestamp, not the fetch time
    const sigma = ev.find((e) => e.claim.startsWith('realized 1d volatility'))!
    expect(sigma.as_of).toBe(CANDLE_AS_OF)
    expect(sigma.source).toBe('geckoterminal:ohlcv:day:0xpool-nvda')
    // the market is cited by id, and both tokens by address
    expect(ev.some((e) => e.source === 'morpho:market:0x0309c02d')).toBe(true)
    expect(ev.some((e) => e.source === 'token:0xde770c84')).toBe(true)
  })
})
