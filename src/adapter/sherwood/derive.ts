// src/adapter/sherwood/derive.ts
// Turns a model's POLICY CHOICES into the strategy's numbers.
//
// The rule this module exists to enforce: the model never writes a measured
// value. It picks bounded, unit-free multipliers (band = k × σ, capital = s ×
// TVL, LTV = f × LLTV) and a venue it resolved to an address; every percentage,
// dollar figure and bps in the emitted spec is computed HERE from live data,
// alongside the expression that produced it and the evidence it came from.
//
// That inversion makes a whole class of defect unreachable rather than merely
// detectable: you cannot reject a hallucinated TVL if the model never gets to
// type a TVL, and a "±3% band" cannot be mis-set for the asset when the band is
// a function of that asset's own realized volatility. It also fixes the
// non-portability of constants — the same multiplier means something on every
// asset, where "±3%" meant something on none of them.
//
// Three things can make a strategy underivable, and each is a refusal rather
// than a guess: no measurable yield basis, no capacity to fill it, or a derived
// net return that is not positive.

import { feeTierFromName, type PoolInfo } from './pools.js'
import type { PoolMetrics } from './metrics.js'
import type { MorphoMarket } from './morpho.js'

/** Largest share of a pool's TVL a single strategy may claim. At 25%+ you are
 *  the pool: you dilute your own fee income and your exit is the dominant flow
 *  in the book you are exiting into. (The reviewed strategy sized 43% of its
 *  real pool.) Set at 0.08 on review. */
export const MAX_POOL_SHARE = 0.08
/** Largest share of a market's lendable liquidity a borrow leg may take. */
export const MAX_BORROW_SHARE_OF_LENDABLE = 0.5
/** A venue whose recent week has collapsed against its fortnight is decaying;
 *  entering it means tripping your own exit rule on day one. */
export const MIN_VOL_TREND_RATIO = 0.6
/** Bottom of the capital band, as a fraction of the top. */
export const CAPITAL_MIN_FRACTION = 0.2

export type StrategyType = 'cl_lp' | 'rebalance' | 'lending_supply' | 'portfolio'

/** One measured input, with where it came from and when it was true. A claim
 *  not in this list may not appear in the thesis. */
export interface Evidence {
  claim: string
  value: string
  source: string
  as_of: string
}

/** The only numbers the model is allowed to choose: bounded and unit-free. */
export interface PolicyChoice {
  /** band = bandSigmaMult × σ_1d */
  bandSigmaMult: number
  /** exit = exitBandMult × band */
  exitBandMult: number
  /** capital max = capitalShareOfTvl × pool TVL */
  capitalShareOfTvl: number
  /** target LTV = ltvFracOfLltv × market LLTV */
  ltvFracOfLltv?: number
  /** de-risk LTV = exitLtvFracOfLltv × market LLTV */
  exitLtvFracOfLltv?: number
}

/** A pool that has been measured — the pairing the whole module runs on. */
export interface Venue {
  pool: PoolInfo
  metrics: PoolMetrics
}

export interface Capacity {
  pool_tvl_usd: number
  /** Share of pool TVL the POSITION occupies — equity × leverage. This is the
   *  figure the depth cap bounds; it equals intended_notional_usd / pool_tvl_usd. */
  max_share_of_pool: number
  /** Share of pool TVL backed by the vault's own capital, before the borrow. */
  equity_share_of_tvl: number
  intended_notional_usd: number
  /** CPMM small-trade approximation at full size, plus the swap fee. */
  est_exit_slippage_bps: number
  borrowable_liquidity_usd?: number
  intended_borrow_usd?: number
  borrow_share_of_lendable?: number
}

/** The inputs `expectedRoeBps` was computed from, as numbers rather than prose.
 *  The derivation strings are for a human voter; this is so a validator (or a
 *  later drift check) can recompute the return without parsing English. */
export interface ExpectedRoeInputs {
  fee_apr_frac?: number
  supply_apr_frac?: number
  borrow_apr_frac?: number
  target_ltv_frac?: number
  leverage: number
  gross_apr_frac: number
  borrow_cost_frac: number
  net_apr_frac: number
  basis: 'pool_fee_apr' | 'market_supply_apy'
}

export interface Derived {
  bandPct: number
  exitPct: number
  capitalMinUsd: number
  capitalMaxUsd: number
  targetLtv?: number
  exitLtv?: number
  borrowUsd?: number
  leverage: number
  feeAprFrac?: number
  supplyAprFrac?: number
  borrowCostFrac?: number
  expectedRoeBps: number
  expectedRoeInputs: ExpectedRoeInputs
  maxDrawdownBps: number
  /** field -> the expression that produced it, with inputs resolved inline. */
  derivation: Record<string, string>
  evidence: Evidence[]
  capacity: Capacity
}

export type DeriveResult = { ok: true; derived: Derived } | { ok: false; reason: string }

const pct = (v: number): string => `${(v * 100).toFixed(2)}%`
const usd = (v: number): string => `$${Math.round(v).toLocaleString('en-US')}`
const bps = (v: number): number => Math.round(v * 10_000)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Is this venue safe to OFFER as an entry? The original strategy had an exit
 *  rule for decaying volume but no entry rule, so nothing stopped it entering a
 *  venue that was visibly dying — it would have entered on the 14d average and
 *  immediately tripped its own exit. */
export function venueRejectReason(v: Venue): string | null {
  if (v.pool.reserveUsd <= 0) return 'pool has no TVL'
  if (v.metrics.sigma1d <= 0) return 'realized volatility is 0 — no measurable band input'
  if (v.metrics.volTrendRatio < MIN_VOL_TREND_RATIO) {
    return `venue is decaying: 7d avg volume ${usd(v.metrics.volAvg7d)} is ${pct(v.metrics.volTrendRatio)} of the 14d avg ${usd(v.metrics.volAvg14d)} (floor ${pct(MIN_VOL_TREND_RATIO)})`
  }
  return null
}

/** Full-range-equivalent fee APR on deployed capital, from TRAILING volume:
 *  vol7d × feeTier / TVL × 365. A floor, deliberately — concentration upside is
 *  not credited, because we cannot measure how much of the range is actually
 *  occupied. Undefined when the pool name carries no fee tier. */
export function feeApr(pool: PoolInfo, metrics: PoolMetrics): number | undefined {
  const tier = feeTierFromName(pool.name)
  if (tier === undefined || pool.reserveUsd <= 0) return undefined
  return ((metrics.volAvg7d * tier) / pool.reserveUsd) * 365
}

/** Price impact of unwinding `notional` into a pool of `tvl`, plus the swap
 *  fee. CPMM small-trade approximation: an LP exit rebalances roughly half the
 *  position through the book. Approximate and labeled as such — the point is
 *  that a position sized at 40% of a pool shows an unmistakable exit cost. */
export function exitSlippageBps(notional: number, tvl: number, feeTier = 0): number {
  if (tvl <= 0) return 10_000
  return Math.round(bps(notional / (2 * tvl)) + bps(feeTier))
}

function buildEvidence(v: Venue, asOf: string, market?: MorphoMarket): Evidence[] {
  const poolSrc = `geckoterminal:pool:${v.pool.address}`
  const ohlcvSrc = `geckoterminal:ohlcv:day:${v.pool.address}`
  const tier = feeTierFromName(v.pool.name)
  const ev: Evidence[] = [
    { claim: 'pool TVL', value: usd(v.pool.reserveUsd), source: poolSrc, as_of: asOf },
    { claim: 'pool 24h volume', value: usd(v.pool.volumeUsd24h), source: poolSrc, as_of: asOf },
    { claim: 'realized 1d volatility (14d)', value: pct(v.metrics.sigma1d), source: ohlcvSrc, as_of: v.metrics.asOf },
    { claim: '7d avg daily volume', value: usd(v.metrics.volAvg7d), source: ohlcvSrc, as_of: v.metrics.asOf },
    { claim: '14d avg daily volume', value: usd(v.metrics.volAvg14d), source: ohlcvSrc, as_of: v.metrics.asOf },
  ]
  if (tier !== undefined) {
    ev.push({ claim: 'pool fee tier', value: pct(tier), source: `${poolSrc}#name`, as_of: asOf })
  }
  if (market) {
    const mSrc = `morpho:market:${market.marketId}`
    ev.push(
      { claim: `LLTV (${market.collateralSymbol}/${market.loanSymbol})`, value: pct(market.lltv), source: mSrc, as_of: asOf },
      { claim: 'borrow APY', value: pct(market.borrowApy), source: mSrc, as_of: asOf },
      { claim: 'lendable liquidity', value: usd(market.liquidityUsd), source: mSrc, as_of: asOf },
      { claim: 'collateral token', value: market.collateralSymbol, source: `token:${market.collateralAddress}`, as_of: asOf },
      { claim: 'borrowed token', value: market.loanSymbol, source: `token:${market.loanAddress}`, as_of: asOf },
    )
  }
  return ev
}

/** Resolve a policy choice against live measurements. Returns a refusal rather
 *  than a number whenever the world does not supply the input. */
export function deriveStrategy(input: {
  strategyType: StrategyType
  venue: Venue
  policy: PolicyChoice
  market?: MorphoMarket
  asOf: string
}): DeriveResult {
  const { strategyType, venue, policy, market, asOf } = input
  const { pool, metrics } = venue

  const venueReject = venueRejectReason(venue)
  if (venueReject) return { ok: false, reason: venueReject }

  const derivation: Record<string, string> = {}

  // --- band and exit: functions of realized volatility, not constants ------
  const bandPct = policy.bandSigmaMult * metrics.sigma1d
  const exitPct = policy.exitBandMult * bandPct
  derivation.band_pct =
    `${policy.bandSigmaMult.toFixed(2)} × σ_1d(14d realized) = ${policy.bandSigmaMult.toFixed(2)} × ${pct(metrics.sigma1d)} = ${pct(bandPct)}`
  derivation.exit_pct =
    `${policy.exitBandMult.toFixed(2)} × band = ${policy.exitBandMult.toFixed(2)} × ${pct(bandPct)} = ${pct(exitPct)}`

  // --- leverage: a function of the market's live LLTV. Derived BEFORE sizing,
  //     because what lands in the pool is capital × leverage and it is THAT the
  //     depth cap has to bound. Capping the equity share instead let an 8% cap
  //     admit a position at 14.6% of TVL (0.08 × 1.82x at LLTV 91.5%), and left
  //     `max_share_of_pool` disagreeing with `intended_notional_usd`.
  let lev: { targetLtv: number; exitLtv: number; market: MorphoMarket } | undefined
  if (market && policy.ltvFracOfLltv !== undefined) {
    const exitFrac = policy.exitLtvFracOfLltv ?? Math.min(0.95, policy.ltvFracOfLltv + 0.2)
    const tLtv = policy.ltvFracOfLltv * market.lltv
    const xLtv = exitFrac * market.lltv
    if (xLtv <= tLtv) {
      return { ok: false, reason: 'derived exit LTV is not above the target LTV — no room to de-risk' }
    }
    if (xLtv >= market.lltv) {
      return { ok: false, reason: `derived exit LTV ${pct(xLtv)} is at or past liquidation LLTV ${pct(market.lltv)}` }
    }
    derivation.target_ltv =
      `${policy.ltvFracOfLltv.toFixed(2)} × LLTV(${pct(market.lltv)}, market ${market.marketId}) = ${pct(tLtv)}`
    derivation.exit_ltv = `${exitFrac.toFixed(2)} × LLTV(${pct(market.lltv)}) = ${pct(xLtv)}`
    lev = { targetLtv: tLtv, exitLtv: xLtv, market }
  }
  const targetLtv = lev?.targetLtv
  const exitLtv = lev?.exitLtv
  const borrowCostFrac = lev ? lev.market.borrowApy * lev.targetLtv : 0

  // borrow = LTV × capital, so leverage is a pure function of the LTV and is
  // known before any dollar figure exists.
  const leverage = lev ? 1 + lev.targetLtv : 1
  derivation.leverage = lev
    ? `1 + target LTV(${pct(lev.targetLtv)}) = ${leverage.toFixed(2)}x (the borrowed leg is deployed alongside the equity)`
    : '1.00x (unlevered)'

  // --- size: a function of the venue's measured depth, not a free parameter -
  const notionalShare = policy.capitalShareOfTvl * leverage
  if (notionalShare > MAX_POOL_SHARE) {
    return {
      ok: false,
      reason: `position would be ${pct(notionalShare)} of pool TVL (capital share ${pct(policy.capitalShareOfTvl)} × leverage ${leverage.toFixed(2)}x), above the ${pct(MAX_POOL_SHARE)} depth cap`,
    }
  }
  const capitalMaxUsd = policy.capitalShareOfTvl * pool.reserveUsd
  const capitalMinUsd = CAPITAL_MIN_FRACTION * capitalMaxUsd
  const notionalUsd = capitalMaxUsd * leverage
  derivation.capital_max_usd =
    `${pct(policy.capitalShareOfTvl)} × pool TVL(${usd(pool.reserveUsd)}) = ${usd(capitalMaxUsd)}`
  derivation.notional_usd =
    `capital max(${usd(capitalMaxUsd)}) × leverage(${leverage.toFixed(2)}x) = ${usd(notionalUsd)} = ${pct(notionalShare)} of pool TVL (depth cap ${pct(MAX_POOL_SHARE)})`
  if (capitalMaxUsd <= 0) return { ok: false, reason: 'derived capital max is 0 — pool too thin to size into' }

  let borrowUsd: number | undefined
  if (lev) {
    borrowUsd = lev.targetLtv * capitalMaxUsd
    derivation.borrow_usd = `target LTV(${pct(lev.targetLtv)}) × capital max(${usd(capitalMaxUsd)}) = ${usd(borrowUsd)}`

    // --- capacity: can this venue actually fill the borrow? ---------------
    const cap = MAX_BORROW_SHARE_OF_LENDABLE * lev.market.liquidityUsd
    if (borrowUsd > cap) {
      return {
        ok: false,
        reason: `borrow of ${usd(borrowUsd)} exceeds ${pct(MAX_BORROW_SHARE_OF_LENDABLE)} of lendable liquidity ${usd(lev.market.liquidityUsd)} in market ${lev.market.marketId}`,
      }
    }
  }

  // --- return: derived from a measurable yield source, or refused ----------
  const tier = feeTierFromName(pool.name)
  const feeAprFrac = feeApr(pool, metrics)
  const supplyAprFrac = strategyType === 'lending_supply' ? market?.supplyApy : undefined
  let grossFrac: number | undefined
  if (strategyType === 'lending_supply') {
    if (supplyAprFrac !== undefined && supplyAprFrac > 0) {
      grossFrac = supplyAprFrac
      derivation.gross_apr = `market supply APY(${pct(supplyAprFrac)}, market ${market?.marketId}) = ${pct(grossFrac)}`
    }
  } else if (strategyType === 'cl_lp' && feeAprFrac !== undefined) {
    grossFrac = feeAprFrac * leverage
    derivation.fee_apr =
      `vol7d(${usd(metrics.volAvg7d)}) × fee(${pct(tier ?? 0)}) / TVL(${usd(pool.reserveUsd)}) × 365 = ${pct(feeAprFrac)} (full-range equivalent; concentration upside not credited)`
    derivation.gross_apr = `fee APR(${pct(feeAprFrac)}) × leverage(${leverage.toFixed(2)}x) = ${pct(grossFrac)}`
  }
  if (grossFrac === undefined) {
    // rebalance/portfolio have no yield source measurable on this data, and a
    // return with no derivation is exactly the unfalsifiable constant this
    // module exists to remove.
    return {
      ok: false,
      reason: `no measurable yield basis for strategy_type "${strategyType}" on ${pool.name} (needs a pool fee tier or a market supply APY)`,
    }
  }

  const netFrac = grossFrac - borrowCostFrac
  derivation.expected_roe =
    borrowCostFrac > 0
      ? `gross(${pct(grossFrac)}) − borrow APY(${pct(market?.borrowApy ?? 0)}) × LTV(${pct(targetLtv ?? 0)}) = ${pct(netFrac)}`
      : `gross(${pct(grossFrac)}) with no borrow cost = ${pct(netFrac)}`
  if (netFrac <= 0) {
    return { ok: false, reason: `derived net ROE is ${pct(netFrac)} — the strategy does not pay for its own borrow` }
  }

  // --- drawdown: the tighter of the two stops that actually fire ----------
  const ltvStop = targetLtv !== undefined && exitLtv !== undefined ? 1 - targetLtv / exitLtv : undefined
  const ddFrac = ltvStop !== undefined ? Math.min(exitPct, ltvStop) : exitPct
  derivation.max_drawdown =
    ltvStop !== undefined
      ? `min(exit band ${pct(exitPct)}, collateral fall to exit LTV ${pct(ltvStop)}) = ${pct(ddFrac)}`
      : `exit band ${pct(exitPct)}`

  // The pod schema takes integer bps in a bounded range, so the published
  // figure can differ from the derived one. Say so in the derivation rather
  // than letting a clamped number sit next to an expression that computes
  // something else — a value disagreeing with its own stated derivation is the
  // defect this module exists to remove, and it does not stop being that
  // because WE introduced the discrepancy.
  const publish = (frac: number, lo: number, hi: number, key: string): number => {
    const raw = bps(frac)
    const out = clamp(raw, lo, hi)
    if (out !== raw) {
      derivation[key] += ` → published as ${out}bps (clamped from ${raw}bps to the pod schema's ${lo}–${hi} range)`
    }
    return out
  }
  const expectedRoeBps = publish(netFrac, 1, 100_000, 'expected_roe')
  const maxDrawdownBps = publish(ddFrac, 100, 10_000, 'max_drawdown')

  // Sized on the LEVERED notional: it is the whole position that has to be
  // unwound into the book, not the equity behind it.
  const slippage = exitSlippageBps(notionalUsd, pool.reserveUsd, tier ?? 0)
  derivation.est_exit_slippage_bps =
    `notional(${usd(notionalUsd)}) / (2 × TVL(${usd(pool.reserveUsd)})) + fee(${pct(tier ?? 0)}) = ${slippage}bps (CPMM small-trade approximation)`

  const capacity: Capacity = {
    pool_tvl_usd: Math.round(pool.reserveUsd),
    // The share of the pool the POSITION occupies, so this stays consistent
    // with intended_notional_usd / pool_tvl_usd. The equity behind it is
    // reported separately rather than passed off as the same thing.
    max_share_of_pool: Number(notionalShare.toFixed(4)),
    equity_share_of_tvl: Number(policy.capitalShareOfTvl.toFixed(4)),
    intended_notional_usd: Math.round(notionalUsd),
    est_exit_slippage_bps: slippage,
    ...(market ? { borrowable_liquidity_usd: Math.round(market.liquidityUsd) } : {}),
    ...(borrowUsd !== undefined ? { intended_borrow_usd: Math.round(borrowUsd) } : {}),
    ...(borrowUsd !== undefined && market && market.liquidityUsd > 0
      ? { borrow_share_of_lendable: Number((borrowUsd / market.liquidityUsd).toFixed(4)) }
      : {}),
  }

  return {
    ok: true,
    derived: {
      bandPct,
      exitPct,
      capitalMinUsd,
      capitalMaxUsd,
      ...(targetLtv !== undefined ? { targetLtv } : {}),
      ...(exitLtv !== undefined ? { exitLtv } : {}),
      ...(borrowUsd !== undefined ? { borrowUsd } : {}),
      leverage,
      ...(feeAprFrac !== undefined ? { feeAprFrac } : {}),
      ...(supplyAprFrac !== undefined ? { supplyAprFrac } : {}),
      ...(borrowCostFrac > 0 ? { borrowCostFrac } : {}),
      expectedRoeBps,
      expectedRoeInputs: {
        ...(feeAprFrac !== undefined ? { fee_apr_frac: Number(feeAprFrac.toFixed(6)) } : {}),
        ...(supplyAprFrac !== undefined ? { supply_apr_frac: Number(supplyAprFrac.toFixed(6)) } : {}),
        ...(market ? { borrow_apr_frac: Number(market.borrowApy.toFixed(6)) } : {}),
        ...(targetLtv !== undefined ? { target_ltv_frac: Number(targetLtv.toFixed(6)) } : {}),
        leverage: Number(leverage.toFixed(4)),
        gross_apr_frac: Number(grossFrac.toFixed(6)),
        borrow_cost_frac: Number(borrowCostFrac.toFixed(6)),
        net_apr_frac: Number(netFrac.toFixed(6)),
        basis: strategyType === 'lending_supply' ? 'market_supply_apy' : 'pool_fee_apr',
      },
      maxDrawdownBps,
      derivation,
      evidence: buildEvidence(venue, asOf, market),
      capacity,
    },
  }
}
