import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { parseTokenPrices, createTokenPricer, roiPercent, failureBackoffMs } from './prices.js'
import type { TokenFlow } from './pnl.js'

const WOOD_ADDR = '0xf8bc08092c06db6148114dcf82af881f1085f92b'
const ADDR_WORD = '0x' + WOOD_ADDR.slice(2).padStart(64, '0')

const geckoBody = (prices: Record<string, string>) => ({ data: { attributes: { token_prices: prices } } })

/** Mirrors PRICE_TTL_MS in prices.ts (not exported — the success TTL is internal). */
const PRICE_TTL = 5 * 60_000

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

describe('failureBackoffMs', () => {
  it('starts short so a cold-start blip is not a full minute of "price unavailable"', () => {
    expect(failureBackoffMs(1)).toBe(5_000)
    expect(failureBackoffMs(2)).toBe(10_000)
  })

  it('doubles up to a 60s ceiling so a real outage never burns the free tier', () => {
    expect(failureBackoffMs(3)).toBe(20_000)
    expect(failureBackoffMs(4)).toBe(40_000)
    expect(failureBackoffMs(5)).toBe(60_000)
    expect(failureBackoffMs(99)).toBe(60_000)
  })
})

describe('roiPercent', () => {
  it('is net over cost basis, as a percentage', () => {
    expect(roiPercent(3, 12)).toBeCloseTo(25)
    expect(roiPercent(-6, 12)).toBeCloseTo(-50)
  })

  it('is null — never Infinity — when nothing was spent, and when an input is unpriced', () => {
    expect(roiPercent(5, 0)).toBeNull()
    expect(roiPercent(5, null)).toBeNull()
    expect(roiPercent(null, 12)).toBeNull()
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
    // …and the percentage return is that net over the $5 cost basis (100 WOOD × $0.05).
    expect(wood.earnedUsd).toBeCloseTo(2.1)
    expect(wood.spentUsd).toBeCloseTo(5)
    expect(out.spentUsd).toBeCloseTo(5)
    expect(out.roiPct).toBeCloseTo(-58)
  })

  it('reports no percentage when nothing has been spent, even with a priced net', async () => {
    const f = fakeFetch(() => geckoBody({ [WOOD_ADDR]: '0.05' }))
    const pricer = createTokenPricer({ fetchImpl: f.impl, env: process.env })
    const out = await pricer.priceTokenFlows(
      [{ symbol: 'WOOD', earned: 42, spent: 0, net: 42 }], econ,
    )
    expect(out.netUsd).toBeCloseTo(2.1)
    expect(out.spentUsd).toBe(0)
    expect(out.roiPct).toBeNull() // no cost basis ⇒ no ratio, not Infinity
  })

  it('returns null netUsd when a nonzero leg is unpriced (fetch outage)', async () => {
    const f = fakeFetch(() => { throw new Error('down') })
    const pricer = createTokenPricer({ fetchImpl: f.impl, env: process.env })
    const out = await pricer.priceTokenFlows(flows, econ)
    expect(out.tokens.find((t) => t.symbol === 'WOOD')!.priceUsd).toBeNull()
    expect(out.netUsd).toBeNull()
    // An unpriced leg that SPENT leaves the cost basis incomplete — reporting a
    // percentage off the priced remainder would overstate the return.
    expect(out.spentUsd).toBeNull()
    expect(out.roiPct).toBeNull()
  })

  it('recovers ~5s after a cold-start failure, not 60s (restart blip)', async () => {
    // The live symptom: the first fetch after `docker compose up` raced container
    // networking, failed, and blanked every price card for a full minute.
    let t = 0
    let down = true
    const f = fakeFetch(() => { if (down) throw new Error('egress not ready'); return geckoBody({ [WOOD_ADDR]: '0.05' }) })
    const pricer = createTokenPricer({ fetchImpl: f.impl, env: process.env, now: () => t })
    expect((await pricer.priceTokenFlows(flows, econ)).netUsd).toBeNull()
    down = false
    t += 4_000 // still inside the first backoff — no refetch yet
    expect((await pricer.priceTokenFlows(flows, econ)).netUsd).toBeNull()
    expect(f.count()).toBe(1)
    t += 2_000 // past 5s — retries and recovers
    expect((await pricer.priceTokenFlows(flows, econ)).netUsd).toBeCloseTo(-2.9)
  })

  it('a success resets the backoff, so a later blip is short again', async () => {
    let t = 0
    let down = false
    const f = fakeFetch(() => { if (down) throw new Error('down'); return geckoBody({ [WOOD_ADDR]: '0.05' }) })
    const pricer = createTokenPricer({ fetchImpl: f.impl, env: process.env, now: () => t })
    await pricer.priceTokenFlows(flows, econ) // ok → fails = 0
    down = true
    t += PRICE_TTL + 1
    expect((await pricer.priceTokenFlows(flows, econ)).netUsd).toBeNull() // 1st failure → 5s
    down = false
    t += 6_000
    expect((await pricer.priceTokenFlows(flows, econ)).netUsd).toBeCloseTo(-2.9)
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
