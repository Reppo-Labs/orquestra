// src/adapter/sherwood/morpho.test.ts
import { describe, it, expect } from 'vitest'
import { parseMorphoMarkets, borrowableAssets } from './morpho.js'

// Shape mirrors blue-api.morpho.org markets(chainId_in:[4663]) — verified live.
const body = {
  data: {
    markets: {
      items: [
        {
          lltv: '770000000000000000',
          listed: true,
          loanAsset: { symbol: 'USDG' },
          collateralAsset: { symbol: 'TSLA', name: 'Tesla (Robinhood Tokenized Stock)' },
          state: { borrowApy: 0.016, liquidityAssetsUsd: 50_000, borrowAssetsUsd: 12 },
        },
        {
          lltv: '920000000000000000',
          listed: true,
          loanAsset: { symbol: 'USDG' },
          collateralAsset: { symbol: 'USDe', name: 'USDe' },
          state: { borrowApy: 0.032, liquidityAssetsUsd: 20_958_354, borrowAssetsUsd: 159_213_637 },
        },
        // unreadable collateral symbol (bytes32 token) — dropped
        { lltv: '620000000000000000', loanAsset: { symbol: 'USDG' }, collateralAsset: { symbol: null, name: null }, state: null },
        // zero LLTV — dropped
        { lltv: '0', loanAsset: { symbol: 'USDG' }, collateralAsset: { symbol: 'X', name: 'X' }, state: null },
        // dust loan liquidity — parsed, but excluded from borrowable set
        {
          lltv: '860000000000000000',
          loanAsset: { symbol: 'csUSDG' },
          collateralAsset: { symbol: 'csWETH', name: 'csWETH' },
          state: { borrowApy: 0.019, liquidityAssetsUsd: 5, borrowAssetsUsd: 0 },
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
      collateralSymbol: 'TSLA',
      collateralName: 'Tesla (Robinhood Tokenized Stock)',
      loanSymbol: 'USDG',
      lltv: 0.77,
      borrowApy: 0.016,
      liquidityUsd: 50_000,
      borrowedUsd: 12,
    })
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
