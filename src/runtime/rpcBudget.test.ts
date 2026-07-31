// src/runtime/rpcBudget.test.ts
// Cycle-level proof for openspec change reduce-rpc-calls: a datanet with many pods must
// cost O(batches) RPC requests, not O(pods). Exercises the exact reader methods
// src/runtime/wiring.ts calls for the cycle's vote-volume and pool reads
// (`reader.epochVoteVolume`, `reader.subnetPools`; see wiring.ts:268,270), with a counting
// fetchImpl standing in for the RPC transport. No real network, no `reppo` CLI spawn.
import { describe, it, expect, beforeEach } from 'vitest'
import { queryEpochVoteVolume } from '../reppo/epochVotes.js'
import { querySubnetPools } from '../reppo/subnetPools.js'
import { resetMulticallAvailabilityCache } from '../reppo/multicall.js'

const word = (v: bigint) => v.toString(16).padStart(64, '0')
const hex = (v: bigint) => '0x' + word(v)

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

describe('cycle RPC budget: many pods, few requests', () => {
  beforeEach(() => resetMulticallAvailabilityCache())

  it('epochVoteVolume + subnetPools for a 200-pod datanet stay O(batches), not O(pods)', async () => {
    const requests: string[] = []
    const f = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { method: string; params: [{ data?: string }] }
      requests.push(body.method)
      if (body.method === 'eth_getCode') return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x6080' }) }
      const data = body.params[0].data ?? ''
      if (data.startsWith('0x76671808')) return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: hex(7n) }) } // currentEpoch
      // aggregate3 request: answer every inner call with a small nonzero value
      // (vote weight, or seedings) — count derived from the request's array-length word.
      const arrLen = Number(BigInt('0x' + data.slice(10 + 64, 10 + 128)))
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: encodeResultFixture(
        Array.from({ length: arrLen }, () => ({ success: true, returnData: hex(1n) })),
      ) }) }
    }) as unknown as typeof fetch

    // These are the exact two on-chain reads a cycle issues per datanet per tick
    // (wiring.ts:268 getEpochVoteVolume, :270 getSubnetPools).
    const pods = Array.from({ length: 200 }, (_, i) => String(i))
    await queryEpochVoteVolume('http://rpc', pods, { fetchImpl: f })
    await querySubnetPools('http://rpc', '3', { fetchImpl: f })

    // 200 pods × 2 getters = 400 individual eth_calls if unbatched. Budget: 1 epoch read
    // + 2 availability probes (one per query function's first call) + 2 aggregate3 batches
    // (one per query) — a small constant, independent of pod count.
    const ethCalls = requests.filter((m) => m === 'eth_call').length
    expect(ethCalls).toBeLessThan(10)
    expect(ethCalls).toBeLessThan(pods.length) // the O(N) shape this change eliminates
  })
})
