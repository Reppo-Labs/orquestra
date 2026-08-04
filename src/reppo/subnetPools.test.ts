// src/reppo/subnetPools.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { querySubnetPools } from './subnetPools.js'
import { resetMulticallAvailabilityCache } from './multicall.js'

const SEL_REPPO = '0x8b473a17'
const SEL_PRIMARY = '0xb4025408'
const word = (v: bigint) => v.toString(16).padStart(64, '0')
const hex = (v: bigint) => '0x' + word(v)
const REPPO = 10n ** 18n

/** Fake JSON-RPC: dispatch on the calldata selector (epochVotes.test.ts pattern). Answers
 *  the multicall availability probe with "no code" so these tests exercise the serial path. */
function fakeFetch(handler: (data: string, to: string) => bigint): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as { method: string; params: [{ data: string; to: string }] }
    if (body.method === 'eth_getCode') return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' }) }
    const result = hex(handler(body.params[0].data, body.params[0].to))
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
  }) as unknown as typeof fetch
}

/** Variant of fakeFetch that can return the literal '0x' (empty returndata) for a given
 *  selector instead of always hex-encoding a bigint. */
function fakeFetchRaw(handler: (data: string, to: string) => bigint | '0x'): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as { method: string; params: [{ data: string; to: string }] }
    if (body.method === 'eth_getCode') return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' }) }
    const out = handler(body.params[0].data, body.params[0].to)
    const result = out === '0x' ? '0x' : hex(out)
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
  }) as unknown as typeof fetch
}

/** Aggregate3 returndata builder + a multicall-answering fetch (multicall.test.ts pattern). */
function encodeResultFixture(results: { success: boolean; returnData: string }[]): string {
  const heads: string[] = []
  const tails: string[] = []
  let off = 32 * results.length
  for (const r of results) {
    heads.push(word(BigInt(off)))
    const data = r.returnData.replace(/^0x/, '')
    const elem = word(r.success ? 1n : 0n) + word(0x40n) + word(BigInt(data.length / 2)) + data
    tails.push(elem)
    off += elem.length / 2
  }
  return '0x' + word(0x20n) + word(BigInt(results.length)) + heads.join('') + tails.join('')
}

describe('querySubnetPools', () => {
  it('reads both pool balances for the subnet from the PodManager', async () => {
    const calls: { data: string; to: string }[] = []
    const f = fakeFetch((data, to) => {
      calls.push({ data, to })
      if (data.startsWith(SEL_REPPO)) return 2_780n * REPPO
      if (data.startsWith(SEL_PRIMARY)) return 215_912n * REPPO
      return 0n
    })
    const out = await querySubnetPools('http://rpc', '22', { fetchImpl: f, podManager: '0xpm' })
    expect(out).toEqual({ reppoWei: 2_780n * REPPO, primaryWei: 215_912n * REPPO })
    // both calls carry the subnetId word and target the PodManager
    expect(calls.find((c) => c.data.startsWith(SEL_REPPO))!.data).toBe(SEL_REPPO + word(22n))
    expect(calls.find((c) => c.data.startsWith(SEL_PRIMARY))!.data).toBe(SEL_PRIMARY + word(22n))
    expect(calls.every((c) => c.to === '0xpm')).toBe(true)
  })

  it('throws (never zero-fills) on an RPC error — a failed read is UNKNOWN, not a dry pool', async () => {
    const f = (async () => ({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'over rate limit' } }),
    })) as unknown as typeof fetch
    await expect(querySubnetPools('http://rpc', '9', { fetchImpl: f })).rejects.toThrow(/over rate limit/)
  })

  it('transport failure throws (caller treats as unavailable, never as zero)', async () => {
    const f = (async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch
    await expect(querySubnetPools('http://rpc', '9', { fetchImpl: f })).rejects.toThrow(/HTTP 502/)
  })

  it('malformed 200 (no result, no error) throws — never a silent zero', async () => {
    const f = (async () => ({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1 }),
    })) as unknown as typeof fetch
    await expect(querySubnetPools('http://rpc', '9', { fetchImpl: f })).rejects.toThrow(/malformed/)
  })

  it("'0x' empty returndata for one call resolves that side to 0n, not a throw", async () => {
    const f = fakeFetchRaw((data) => {
      if (data.startsWith(SEL_REPPO)) return 2_780n * REPPO
      if (data.startsWith(SEL_PRIMARY)) return '0x'
      return 0n
    })
    const out = await querySubnetPools('http://rpc', '22', { fetchImpl: f, podManager: '0xpm' })
    expect(out).toEqual({ reppoWei: 2_780n * REPPO, primaryWei: 0n })
  })
})

describe('querySubnetPools — multicall path', () => {
  beforeEach(() => resetMulticallAvailabilityCache())

  it('reads both seedings in ONE aggregate3 request when Multicall3 is deployed', async () => {
    const methods: string[] = []
    const f = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { method: string }
      methods.push(body.method)
      if (body.method === 'eth_getCode') return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x6080' }) }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: encodeResultFixture([
        { success: true, returnData: hex(2_780n * REPPO) },
        { success: true, returnData: hex(215_912n * REPPO) },
      ]) }) }
    }) as unknown as typeof fetch
    const out = await querySubnetPools('http://rpc-mc', '22', { fetchImpl: f, podManager: '0xpm' })
    expect(out).toEqual({ reppoWei: 2_780n * REPPO, primaryWei: 215_912n * REPPO })
    expect(methods).toEqual(['eth_getCode', 'eth_call']) // probe + ONE aggregate, not 2 eth_calls
  })

  it('an inner revert throws (pool unknown), never a fabricated dry pool', async () => {
    const f = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { method: string }
      if (body.method === 'eth_getCode') return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x6080' }) }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: encodeResultFixture([
        { success: true, returnData: hex(1n) },
        { success: false, returnData: '0x' },
      ]) }) }
    }) as unknown as typeof fetch
    await expect(querySubnetPools('http://rpc-mc2', '22', { fetchImpl: f, podManager: '0xpm' }))
      .rejects.toThrow(/reverted in multicall/)
  })
})

describe('querySubnetPools — robinhood (RBV1)', () => {
  const SEL_RB = '0xe71a6530' // getSubnetSeedings(uint256)

  afterEach(() => vi.unstubAllEnvs())

  it('reads the single RBV1 pool as primaryWei and reports reppoWei as 0', async () => {
    vi.stubEnv('REPPO_NETWORK', 'robinhood')
    const calls: { data: string; to: string }[] = []
    const f = fakeFetch((data, to) => {
      calls.push({ data, to })
      if (data.startsWith(SEL_RB)) return 7_500n * REPPO
      throw new Error(`unexpected selector on robinhood: ${data.slice(0, 10)}`)
    })
    const out = await querySubnetPools('http://rpc', '1', { fetchImpl: f })
    expect(out).toEqual({ reppoWei: 0n, primaryWei: 7_500n * REPPO })
    // targets the RBV1 PodManager by default, with the subnetId word
    expect(calls).toHaveLength(1)
    expect(calls[0].to).toBe('0xeAd1A577B02829b7F634aD7eE30Fbbc2CDF7e478')
    expect(calls[0].data).toBe(SEL_RB + word(1n))
  })
})
