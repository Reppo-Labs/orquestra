// src/reppo/subnetPools.test.ts
import { describe, it, expect } from 'vitest'
import { querySubnetPools } from './subnetPools.js'

const SEL_REPPO = '0x8b473a17'
const SEL_PRIMARY = '0xb4025408'
const word = (v: bigint) => v.toString(16).padStart(64, '0')
const hex = (v: bigint) => '0x' + word(v)
const REPPO = 10n ** 18n

/** Fake JSON-RPC: dispatch on the calldata selector (epochVotes.test.ts pattern). */
function fakeFetch(handler: (data: string, to: string) => bigint): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as { params: [{ data: string; to: string }] }
    const result = hex(handler(body.params[0].data, body.params[0].to))
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
  }) as unknown as typeof fetch
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
    expect(calls.every((c) => c.to === '0xpm')).toBe(true)
  })

  it('throws (never zero-fills) on an RPC error — a failed read is UNKNOWN, not a dry pool', async () => {
    const f = (async () => ({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'over rate limit' } }),
    })) as unknown as typeof fetch
    await expect(querySubnetPools('http://rpc', '9', { fetchImpl: f })).rejects.toThrow(/over rate limit/)
  })
})
