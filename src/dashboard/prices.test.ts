import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { parseTokenPrices, createTokenPricer } from './prices.js'
import type { TokenFlow } from './pnl.js'

const WOOD_ADDR = '0xf8bc08092c06db6148114dcf82af881f1085f92b'
const ADDR_WORD = '0x' + WOOD_ADDR.slice(2).padStart(64, '0')

const geckoBody = (prices: Record<string, string>) => ({ data: { attributes: { token_prices: prices } } })

/** fetch stub: eth_call requests (POST) get the WOOD address word; GeckoTerminal
 *  GETs are answered by `gecko` (throw to simulate an outage). Counts gecko hits. */
function fakeFetch(gecko: () => unknown) {
  let geckoCalls = 0
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: ADDR_WORD }) }
    }
    geckoCalls++
    return { ok: true, json: async () => gecko() }
  }) as unknown as typeof fetch
  return { impl, count: () => geckoCalls }
}

const flows: TokenFlow[] = [
  { symbol: 'REPPO', earned: 0, spent: 0, net: 0 },
  { symbol: 'WOOD', earned: 42, spent: 100, net: -58 },
]
const econ = [{ datanetId: '3', nativeTokenSymbol: 'WOOD' }]

describe('parseTokenPrices', () => {
  it('maps addresses (lowercased) to numeric prices, dropping junk rows', () => {
    const m = parseTokenPrices(geckoBody({ [WOOD_ADDR.toUpperCase()]: '0.05', '0xbad': 'not-a-number', '0xzero': '0' }))
    expect(m.get(WOOD_ADDR.toLowerCase())).toBe(0.05)
    expect(m.size).toBe(1)
  })

  it('tolerates malformed bodies', () => {
    expect(parseTokenPrices(null).size).toBe(0)
    expect(parseTokenPrices({ data: {} }).size).toBe(0)
  })
})

describe('createTokenPricer', () => {
  beforeEach(() => {
    vi.stubEnv('REPPO_NETWORK', 'robinhood')
    vi.stubEnv('RPC_URL', 'https://rpc.example')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('prices a robinhood fee-token leg via on-chain address + GeckoTerminal spot', async () => {
    const f = fakeFetch(() => geckoBody({ [WOOD_ADDR]: '0.05' }))
    const pricer = createTokenPricer({ fetchImpl: f.impl, env: process.env })
    const out = await pricer.priceTokenFlows(flows, econ)
    const wood = out.tokens.find((t) => t.symbol === 'WOOD')!
    expect(wood.priceUsd).toBe(0.05)
    expect(wood.netUsd).toBeCloseTo(-2.9)
    // REPPO leg is unpriceable on robinhood (no REPPO token) but its net is 0,
    // so the dollar total still totals.
    expect(out.netUsd).toBeCloseTo(-2.9)
  })

  it('returns null netUsd when a nonzero leg is unpriced (fetch outage)', async () => {
    const f = fakeFetch(() => { throw new Error('down') })
    const pricer = createTokenPricer({ fetchImpl: f.impl, env: process.env })
    const out = await pricer.priceTokenFlows(flows, econ)
    expect(out.tokens.find((t) => t.symbol === 'WOOD')!.priceUsd).toBeNull()
    expect(out.netUsd).toBeNull()
  })

  it('caches spots — a second call inside the TTL does not refetch', async () => {
    let t = 0
    const f = fakeFetch(() => geckoBody({ [WOOD_ADDR]: '0.05' }))
    const pricer = createTokenPricer({ fetchImpl: f.impl, env: process.env, now: () => t })
    await pricer.priceTokenFlows(flows, econ)
    t += 60_000 // within the 5-min TTL
    await pricer.priceTokenFlows(flows, econ)
    expect(f.count()).toBe(1)
    t += 5 * 60_000 // past the TTL — refetches
    await pricer.priceTokenFlows(flows, econ)
    expect(f.count()).toBe(2)
  })

  it('without RPC_URL the fee-token leg degrades to unpriced, never throws', async () => {
    vi.stubEnv('RPC_URL', '')
    const f = fakeFetch(() => geckoBody({ [WOOD_ADDR]: '0.05' }))
    const pricer = createTokenPricer({ fetchImpl: f.impl, env: process.env })
    const out = await pricer.priceTokenFlows(flows, econ)
    expect(out.tokens.find((t) => t.symbol === 'WOOD')!.priceUsd).toBeNull()
    expect(out.netUsd).toBeNull()
    expect(f.count()).toBe(0) // no address resolved → nothing to price
  })

  it('testnet has no market data: every leg unpriced, no fetches', async () => {
    vi.stubEnv('REPPO_NETWORK', 'testnet')
    const f = fakeFetch(() => geckoBody({ [WOOD_ADDR]: '0.05' }))
    const pricer = createTokenPricer({ fetchImpl: f.impl, env: process.env })
    const out = await pricer.priceTokenFlows(flows, econ)
    expect(out.netUsd).toBeNull()
    expect(f.count()).toBe(0)
  })
})
