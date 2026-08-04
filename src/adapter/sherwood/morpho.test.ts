// src/adapter/sherwood/morpho.test.ts
import { describe, it, expect } from 'vitest'
import { parseMorphoMarkets, borrowableAssets, findMarket } from './morpho.js'

// Shape mirrors blue-api.morpho.org markets(chainId_in:[4663]) — verified live.
const body = {
  data: {
    markets: {
      items: [
        {
          marketId: '0xmkt-tsla',
          lltv: '770000000000000000',
          listed: true,
          loanAsset: { symbol: 'USDG', address: '0xusdg' },
          collateralAsset: { symbol: 'TSLA', name: 'Tesla (Robinhood Tokenized Stock)', address: '0xtsla' },
          state: { borrowApy: 0.016, supplyApy: 0.011, liquidityAssetsUsd: 50_000, borrowAssetsUsd: 12 },
        },
        {
          marketId: '0xmkt-usde',
          lltv: '920000000000000000',
          listed: true,
          loanAsset: { symbol: 'USDG', address: '0xusdg' },
          collateralAsset: { symbol: 'USDe', name: 'USDe', address: '0xusde' },
          state: { borrowApy: 0.032, supplyApy: 0.028, liquidityAssetsUsd: 20_958_354, borrowAssetsUsd: 159_213_637 },
        },
        // unreadable collateral symbol (bytes32 token) — dropped
        { marketId: '0xmkt-bad', lltv: '620000000000000000', loanAsset: { symbol: 'USDG' }, collateralAsset: { symbol: null, name: null }, state: null },
        // zero LLTV — dropped
        { marketId: '0xmkt-zero', lltv: '0', loanAsset: { symbol: 'USDG' }, collateralAsset: { symbol: 'X', name: 'X' }, state: null },
        // dust loan liquidity — parsed, but excluded from borrowable set
        {
          marketId: '0xmkt-cs',
          lltv: '860000000000000000',
          loanAsset: { symbol: 'csUSDG', address: '0xcsusdg' },
          collateralAsset: { symbol: 'csWETH', name: 'csWETH', address: '0xcsweth' },
          state: { borrowApy: 0.019, supplyApy: 0.009, liquidityAssetsUsd: 5, borrowAssetsUsd: 0 },
        },
      ],
    },
  },
}

describe('parseMorphoMarkets', () => {
  it('parses markets and drops unreadable/degenerate rows', () => {
    const markets = parseMorphoMarkets(body)
    expect(markets).toHaveLength(3)
    expect(markets[0]).toEqual({
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
    })
  })

  it('carries the market identifier so a cited market is checkable, not believable', () => {
    expect(parseMorphoMarkets(body).map((m) => m.marketId)).toEqual(['0xmkt-tsla', '0xmkt-usde', '0xmkt-cs'])
  })

  it('malformed body → []', () => {
    expect(parseMorphoMarkets({})).toEqual([])
    expect(parseMorphoMarkets(null)).toEqual([])
    expect(parseMorphoMarkets({ data: { markets: { items: 'nope' } } })).toEqual([])
  })
})

describe('borrowableAssets', () => {
  it('collects loan symbols of markets with real lendable liquidity (uppercased)', () => {
    const set = borrowableAssets(parseMorphoMarkets(body))
    expect(set).toEqual(new Set(['USDG'])) // csUSDG dust market excluded
  })
  it('empty markets → empty set (gate switches off)', () => {
    expect(borrowableAssets([]).size).toBe(0)
  })
})

describe('findMarket', () => {
  const markets = parseMorphoMarkets(body)

  it('resolves by market id', () => {
    expect(findMarket(markets, { marketId: '0xMKT-USDE' })?.collateralSymbol).toBe('USDe')
  })

  it('resolves by (collateral, loan) symbols, case-insensitively', () => {
    expect(findMarket(markets, { collateralSymbol: 'tsla', loanSymbol: 'usdg' })?.marketId).toBe('0xmkt-tsla')
  })

  it('picks the DEEPEST market when a pair is listed more than once', () => {
    // chain 4663 lists the same pair at several LLTVs, most with zero liquidity
    const dupes = [
      { ...markets[0], marketId: '0xdust', liquidityUsd: 0 },
      { ...markets[0], marketId: '0xdeep', liquidityUsd: 500_000 },
    ]
    expect(findMarket(dupes, { collateralSymbol: 'TSLA', loanSymbol: 'USDG' })?.marketId).toBe('0xdeep')
  })

  it('undefined when nothing resolves — the leg must be dropped, not guessed', () => {
    expect(findMarket(markets, { marketId: '0xnope' })).toBeUndefined()
    expect(findMarket(markets, { collateralSymbol: 'spUSDG', loanSymbol: 'USDG' })).toBeUndefined()
    expect(findMarket(markets, {})).toBeUndefined()
  })
})
