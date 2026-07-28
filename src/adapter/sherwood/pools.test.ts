// src/adapter/sherwood/pools.test.ts
import { describe, it, expect } from 'vitest'
import { parsePools } from './pools.js'

// Shape mirrors GeckoTerminal /api/v2/networks/robinhood/pools (verified live).
const page = {
  data: [
    {
      attributes: {
        name: 'WOOD / WETH 0.3%',
        address: '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca',
        reserve_in_usd: '512345.67',
        volume_usd: { h24: '987654.3' },
      },
      relationships: { dex: { data: { id: 'sushiswap-robinhood' } } },
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
}

describe('parsePools', () => {
  it('parses well-formed rows and drops malformed ones', () => {
    const pools = parsePools(page)
    expect(pools).toHaveLength(2)
    expect(pools[0]).toEqual({
      name: 'WOOD / WETH 0.3%',
      address: '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca',
      dex: 'sushiswap-robinhood',
      reserveUsd: 512345.67,
      volumeUsd24h: 987654.3,
    })
    // bad numerics degrade to 0, missing dex to "unknown" — row survives
    expect(pools[1]).toEqual({ name: 'BAD / NUMS', address: '0xbad', dex: 'unknown', reserveUsd: 0, volumeUsd24h: 0 })
  })

  it('non-array / missing data → []', () => {
    expect(parsePools({})).toEqual([])
    expect(parsePools(null)).toEqual([])
    expect(parsePools({ data: 'nope' })).toEqual([])
  })
})
