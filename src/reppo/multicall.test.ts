// src/reppo/multicall.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  encodeAggregate3, decodeAggregate3, tryAggregate, isMulticallAvailable,
  resetMulticallAvailabilityCache, MULTICALL3_ADDRESS, type Call3Result,
} from './multicall.js'

const word = (v: bigint) => v.toString(16).padStart(64, '0')
const ADDR = '0x' + 'aa'.repeat(20)

/** Independently-built aggregate3 returndata: (bool success, bytes returnData)[]. */
function encodeResultFixture(results: Call3Result[]): string {
  const heads: string[] = []
  const tails: string[] = []
  let off = 32 * results.length
  for (const r of results) {
    heads.push(word(BigInt(off)))
    const data = r.returnData.replace(/^0x/, '')
    const padded = data.length % 64 === 0 ? data : data + '0'.repeat(64 - (data.length % 64))
    const elem = word(r.success ? 1n : 0n) + word(0x40n) + word(BigInt(data.length / 2)) + padded
    tails.push(elem)
    off += elem.length / 2
  }
  return '0x' + word(0x20n) + word(BigInt(results.length)) + heads.join('') + tails.join('')
}

describe('encodeAggregate3', () => {
  it('encodes a single call to the golden ABI layout', () => {
    const out = encodeAggregate3([{ target: ADDR, callData: '0x12345678' }])
    const expected =
      '0x82ad56cb' +
      word(0x20n) + // offset to array
      word(1n) + // length
      word(0x20n) + // element 0 offset (past the 1-word offsets area)
      '0'.repeat(24) + 'aa'.repeat(20) + // target
      word(1n) + // allowFailure = true
      word(0x60n) + // offset to bytes within tuple
      word(4n) + // calldata length
      '12345678' + '0'.repeat(56) // calldata padded
    expect(out).toBe(expected)
  })
})

describe('decodeAggregate3', () => {
  it('decodes mixed success/revert results, preserving order and empty returndata', () => {
    const hex = encodeResultFixture([
      { success: true, returnData: '0x' + word(42n) },
      { success: false, returnData: '0x' },
    ])
    expect(decodeAggregate3(hex)).toEqual([
      { success: true, returnData: '0x' + word(42n) },
      { success: false, returnData: '0x' },
    ])
  })
})

describe('tryAggregate', () => {
  it('chunks 450 calls into 3 requests and preserves order across chunks', async () => {
    const requestNs: number[] = []
    let served = 0
    const f = (async (_url: unknown, init: unknown) => {
      const data = (JSON.parse((init as { body: string }).body) as { params: [{ data: string }] }).params[0].data
      const n = Number(BigInt('0x' + data.slice(10 + 64, 10 + 128))) // array length word
      requestNs.push(n)
      const results = Array.from({ length: n }, () => ({ success: true, returnData: '0x' + word(BigInt(served++)) }))
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: encodeResultFixture(results) }) }
    }) as unknown as typeof fetch
    const calls = Array.from({ length: 450 }, () => ({ target: ADDR, callData: '0x12345678' }))
    const out = await tryAggregate('http://rpc', calls, { fetchImpl: f })
    expect(requestNs).toEqual([200, 200, 50])
    expect(out).toHaveLength(450)
    expect(out[0].returnData).toBe('0x' + word(0n))
    expect(out[449].returnData).toBe('0x' + word(449n))
  })

  it('sends requests to the canonical Multicall3 address', async () => {
    let to = ''
    const f = (async (_url: unknown, init: unknown) => {
      to = (JSON.parse((init as { body: string }).body) as { params: [{ to: string }] }).params[0].to
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: encodeResultFixture([{ success: true, returnData: '0x' }]) }) }
    }) as unknown as typeof fetch
    await tryAggregate('http://rpc', [{ target: ADDR, callData: '0x01' }], { fetchImpl: f })
    expect(to).toBe(MULTICALL3_ADDRESS)
  })

  it('throws on transport failure (batch unavailable, never partial)', async () => {
    const f = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch
    await expect(tryAggregate('http://rpc', [{ target: ADDR, callData: '0x01' }], { fetchImpl: f }))
      .rejects.toThrow(/HTTP 429/)
  })

  it('throws when the result count does not match the request', async () => {
    const f = (async () => ({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: encodeResultFixture([]) }),
    })) as unknown as typeof fetch
    await expect(tryAggregate('http://rpc', [{ target: ADDR, callData: '0x01' }], { fetchImpl: f }))
      .rejects.toThrow(/expected 1 results, got 0/)
  })
})

describe('isMulticallAvailable', () => {
  beforeEach(() => resetMulticallAvailabilityCache())

  const codeFetch = (result: string, counter: { n: number }) =>
    (async () => {
      counter.n++
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
    }) as unknown as typeof fetch

  it('true when code is present, and the probe is cached', async () => {
    const c = { n: 0 }
    const f = codeFetch('0x60806040', c)
    expect(await isMulticallAvailable('http://rpc', { fetchImpl: f })).toBe(true)
    expect(await isMulticallAvailable('http://rpc', { fetchImpl: f })).toBe(true)
    expect(c.n).toBe(1) // second call served from cache
  })

  it('false when no code is deployed, and that is cached too', async () => {
    const c = { n: 0 }
    const f = codeFetch('0x', c)
    expect(await isMulticallAvailable('http://rpc', { fetchImpl: f })).toBe(false)
    expect(await isMulticallAvailable('http://rpc', { fetchImpl: f })).toBe(false)
    expect(c.n).toBe(1)
  })

  it('probe failure returns false but is NOT cached (re-probes next time)', async () => {
    const c = { n: 0 }
    const failing = (async () => {
      c.n++
      return { ok: false, status: 502, json: async () => ({}) }
    }) as unknown as typeof fetch
    expect(await isMulticallAvailable('http://rpc', { fetchImpl: failing })).toBe(false)
    expect(await isMulticallAvailable('http://rpc', { fetchImpl: failing })).toBe(false)
    expect(c.n).toBe(2) // no caching of transient failure
  })
})
