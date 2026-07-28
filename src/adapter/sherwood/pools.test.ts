// src/adapter/sherwood/pools.test.ts
import { describe, it, expect } from 'vitest'
import { parsePools, tokenizedStocks, fetchRobinhoodPools } from './pools.js'

// Shape mirrors GeckoTerminal /networks/robinhood/pools?include=base_token,quote_token
// (verified live; the "(Robinhood Tokenized Stock)" name marker is the RWA classifier).
const page = {
  data: [
    {
      attributes: {
        name: 'nvda / USDG 0.05%',
        address: '0xpool-nvda',
        reserve_in_usd: '1313951',
        volume_usd: { h24: '9566986' },
      },
      relationships: {
        dex: { data: { id: 'uniswap-v3-robinhood' } },
        base_token: { data: { id: 'robinhood_0xnvda' } },
        quote_token: { data: { id: 'robinhood_0xusdg' } },
      },
    },
    // malformed rows: dropped, never thrown
    { attributes: { name: 'No Address' } },
    { attributes: null },
    {
      attributes: {
        name: 'BAD / NUMS',
        address: '0xbad',
        reserve_in_usd: 'not-a-number',
        volume_usd: {},
      },
    },
  ],
  included: [
    { id: 'robinhood_0xnvda', type: 'token', attributes: { symbol: 'nvda', name: 'NVIDIA (Robinhood Tokenized Stock)', address: '0xnvda' } },
    { id: 'robinhood_0xusdg', type: 'token', attributes: { symbol: 'USDG', name: 'Global Dollar', address: '0xusdg' } },
  ],
}

describe('parsePools', () => {
  it('parses rows, joins token metadata, and flags tokenized stocks', () => {
    const pools = parsePools(page)
    expect(pools).toHaveLength(2)
    expect(pools[0]).toMatchObject({
      name: 'nvda / USDG 0.05%',
      address: '0xpool-nvda',
      dex: 'uniswap-v3-robinhood',
      reserveUsd: 1_313_951,
      volumeUsd24h: 9_566_986,
    })
    expect(pools[0].base).toEqual({ symbol: 'nvda', name: 'NVIDIA (Robinhood Tokenized Stock)', address: '0xnvda', isTokenizedStock: true })
    expect(pools[0].quote).toEqual({ symbol: 'USDG', name: 'Global Dollar', address: '0xusdg', isTokenizedStock: false })
    // bad numerics degrade to 0, missing dex/tokens survive
    expect(pools[1]).toMatchObject({ name: 'BAD / NUMS', address: '0xbad', dex: 'unknown', reserveUsd: 0, volumeUsd24h: 0 })
    expect(pools[1].base).toBeUndefined()
  })

  it('non-array / missing data → []', () => {
    expect(parsePools({})).toEqual([])
    expect(parsePools(null)).toEqual([])
    expect(parsePools({ data: 'nope' })).toEqual([])
  })
})

describe('tokenizedStocks', () => {
  it('returns unique RWA tokens across pools', () => {
    const pools = parsePools(page)
    const rwa = tokenizedStocks([...pools, ...pools]) // duplicated on purpose
    expect(rwa).toEqual([
      { symbol: 'nvda', name: 'NVIDIA (Robinhood Tokenized Stock)', address: '0xnvda', isTokenizedStock: true },
    ])
  })
})

describe('fetchRobinhoodPools', () => {
  const okPage = (body: unknown): Response =>
    ({ ok: true, json: async () => body }) as unknown as Response

  it('concatenates pages, stops on an empty page, dedups by pool address', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      if (url.includes('page=1')) return okPage(page)
      if (url.includes('page=2')) return okPage(page) // duplicate pools — must dedup
      return okPage({ data: [] })
    }) as unknown as typeof fetch
    const pools = await fetchRobinhoodPools(fetchImpl, 3)
    expect(calls).toHaveLength(3)
    expect(pools).toHaveLength(2) // dedup collapsed the repeat page
    expect(calls[0]).toContain('include=base_token,quote_token')
  })

  it('first-page failure throws; tail-page failure only narrows coverage', async () => {
    const failFirst = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch
    await expect(fetchRobinhoodPools(failFirst, 2)).rejects.toThrow(/HTTP 500/)

    const failTail = (async (url: string) => {
      if (url.includes('page=1')) return okPage(page)
      throw new Error('429')
    }) as unknown as typeof fetch
    const pools = await fetchRobinhoodPools(failTail, 3)
    expect(pools).toHaveLength(2) // page 1 delivered despite tail blip
  })
})
