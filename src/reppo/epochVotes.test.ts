// src/reppo/epochVotes.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { queryEpochVoteVolume } from './epochVotes.js'
import { resetMulticallAvailabilityCache, type Call3Result } from './multicall.js'

const SEL_EPOCH = '0x76671808'
const SEL_UP = '0x7b9683b2'
const SEL_DOWN = '0xae95ff10'
const word = (v: bigint) => v.toString(16).padStart(64, '0')
const hex = (v: bigint) => '0x' + word(v)

/** Fake JSON-RPC: dispatch on the calldata selector. Answers the multicall availability
 *  probe with "no code" so these tests exercise the serial path. */
function fakeFetch(handler: (data: string) => bigint): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as { method: string; params: [{ data: string }] }
    if (body.method === 'eth_getCode') return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' }) }
    const result = hex(handler(body.params[0].data))
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
  }) as unknown as typeof fetch
}

/** Independently-built aggregate3 returndata: (bool success, bytes returnData)[]. */
function encodeResultFixture(results: Call3Result[]): string {
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

describe('queryEpochVoteVolume (multicall path)', () => {
  beforeEach(() => resetMulticallAvailabilityCache())

  it('batches the 2×N vote getters into one aggregate3 request, same totals as serial', async () => {
    const methods: string[] = []
    const f = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { method: string; params: [{ data?: string }] }
      methods.push(body.method)
      if (body.method === 'eth_getCode') {
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x6080' }) }
      }
      const data = body.params[0].data ?? ''
      if (data.startsWith(SEL_EPOCH)) {
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: hex(7n) }) }
      }
      // the aggregate3 request: answer the 4 inner calls (up=3, down=1 per pod) in order
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: encodeResultFixture([
        { success: true, returnData: hex(3n * 10n ** 18n) },
        { success: true, returnData: hex(1n * 10n ** 18n) },
        { success: true, returnData: hex(3n * 10n ** 18n) },
        { success: true, returnData: hex(1n * 10n ** 18n) },
      ]) }) }
    }) as unknown as typeof fetch
    const out = await queryEpochVoteVolume('http://rpc-mc', ['5', '6'], { fetchImpl: f })
    expect(out).toEqual({ epoch: 7, totalRaw: 8n * 10n ** 18n })
    expect(methods).toEqual(['eth_call', 'eth_getCode', 'eth_call']) // epoch read, probe, ONE aggregate — not 2×N calls
  })

  it('an inner revert throws (volume unavailable), never a fabricated zero', async () => {
    const f = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { method: string; params: [{ data?: string }] }
      if (body.method === 'eth_getCode') return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x6080' }) }
      const data = body.params[0].data ?? ''
      if (data.startsWith(SEL_EPOCH)) return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: hex(7n) }) }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: encodeResultFixture([
        { success: true, returnData: hex(1n) },
        { success: false, returnData: '0x' },
      ]) }) }
    }) as unknown as typeof fetch
    await expect(queryEpochVoteVolume('http://rpc-mc2', ['5'], { fetchImpl: f })).rejects.toThrow(/reverted in multicall/)
  })
})

describe('queryEpochVoteVolume', () => {
  it('reads current epoch then sums up+down weight across pods', async () => {
    const calls: string[] = []
    const f = fakeFetch((data) => {
      calls.push(data)
      if (data.startsWith(SEL_EPOCH)) return 7n
      if (data.startsWith(SEL_UP)) return 3n * 10n ** 18n   // 3 REPPO-weight up per pod
      if (data.startsWith(SEL_DOWN)) return 1n * 10n ** 18n // 1 down per pod
      return 0n
    })
    const out = await queryEpochVoteVolume('http://rpc', ['5', '6'], { fetchImpl: f })
    expect(out.epoch).toBe(7)
    expect(out.totalRaw).toBe(8n * 10n ** 18n) // (3+1) × 2 pods
    // vote-weight calls carry (epoch, podId) words
    const up5 = calls.find((d) => d.startsWith(SEL_UP))
    expect(up5).toBe(SEL_UP + word(7n) + word(5n))
  })

  it('dedupes pod ids', async () => {
    let weightCalls = 0
    const f = fakeFetch((data) => {
      if (data.startsWith(SEL_EPOCH)) return 7n
      weightCalls++
      return 10n ** 18n
    })
    const out = await queryEpochVoteVolume('http://rpc', ['5', '5', '5'], { fetchImpl: f })
    expect(weightCalls).toBe(2) // one up + one down for the single distinct pod
    expect(out.totalRaw).toBe(2n * 10n ** 18n)
  })

  it('empty pod list: volume 0, epoch still read', async () => {
    const f = fakeFetch((data) => (data.startsWith(SEL_EPOCH) ? 7n : 0n))
    const out = await queryEpochVoteVolume('http://rpc', [], { fetchImpl: f })
    expect(out).toEqual({ epoch: 7, totalRaw: 0n })
  })

  it('transport failure throws (caller treats as unavailable, never as zero)', async () => {
    const f = (async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch
    await expect(queryEpochVoteVolume('http://rpc', ['5'], { fetchImpl: f })).rejects.toThrow(/HTTP 502/)
  })

  it('JSON-RPC error body throws with the node message', async () => {
    const f = (async () => ({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'boom' } }),
    })) as unknown as typeof fetch
    await expect(queryEpochVoteVolume('http://rpc', ['5'], { fetchImpl: f })).rejects.toThrow(
      /RPC eth_call error: boom/,
    )
  })

  it('malformed 200 (no result, no error) throws — never a silent zero', async () => {
    const f = (async () => ({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1 }),
    })) as unknown as typeof fetch
    await expect(queryEpochVoteVolume('http://rpc', ['5'], { fetchImpl: f })).rejects.toThrow(
      /malformed response/,
    )
  })
})
