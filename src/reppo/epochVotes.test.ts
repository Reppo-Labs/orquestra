// src/reppo/epochVotes.test.ts
import { describe, it, expect } from 'vitest'
import { queryEpochVoteVolume } from './epochVotes.js'

const SEL_EPOCH = '0x76671808'
const SEL_UP = '0x7b9683b2'
const SEL_DOWN = '0xae95ff10'
const word = (v: bigint) => v.toString(16).padStart(64, '0')
const hex = (v: bigint) => '0x' + word(v)

/** Fake JSON-RPC: dispatch on the calldata selector. */
function fakeFetch(handler: (data: string) => bigint): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as { params: [{ data: string }] }
    const result = hex(handler(body.params[0].data))
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
  }) as unknown as typeof fetch
}

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
})
