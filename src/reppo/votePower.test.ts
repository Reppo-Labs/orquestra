// src/reppo/votePower.test.ts
import { describe, it, expect } from 'vitest'
import { queryVotePowerBudget } from './votePower.js'

const SEL_POWER = '0xbcc3f3bd'
const SEL_EPOCH = '0x76671808'
const SEL_EPOCH_END = '0xd9be1efe'
const SEL_CASTED = '0x3827cb73'
const word = (v: bigint) => v.toString(16).padStart(64, '0')
const hex = (v: bigint) => '0x' + word(v)
const WALLET = '0x63742FCF698dbe9368B6e88F6900F5af6b9B9b82'
const REPPO = 10n ** 18n

/** Fake JSON-RPC: dispatch on the calldata selector. */
function fakeFetch(handler: (data: string, to: string) => bigint): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as { params: [{ data: string; to: string }] }
    const result = hex(handler(body.params[0].data, body.params[0].to))
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
  }) as unknown as typeof fetch
}

describe('queryVotePowerBudget', () => {
  it('reads epoch, power, casted, and epoch end — remaining = power − casted', async () => {
    const calls: { data: string; to: string }[] = []
    const f = fakeFetch((data, to) => {
      calls.push({ data, to })
      if (data.startsWith(SEL_EPOCH_END)) return 1_784_121_961n
      if (data.startsWith(SEL_EPOCH)) return 117n
      if (data.startsWith(SEL_POWER)) return 59_000n * REPPO
      if (data.startsWith(SEL_CASTED)) return 150n * REPPO
      return 0n
    })
    const out = await queryVotePowerBudget('http://rpc', WALLET, {
      fetchImpl: f,
      podManager: '0xpm',
      veReppo: '0xve',
    })
    expect(out.epoch).toBe(117)
    expect(out.votingPowerWei).toBe(59_000n * REPPO)
    expect(out.votesCastedWei).toBe(150n * REPPO)
    expect(out.remainingWei).toBe(58_850n * REPPO)
    expect(out.epochEndsAtSec).toBe(1_784_121_961)

    // votesCasted carries (wallet, epoch) words and targets the PodManager.
    const casted = calls.find((c) => c.data.startsWith(SEL_CASTED))!
    expect(casted.data).toBe(SEL_CASTED + word(BigInt(WALLET)) + word(117n))
    expect(casted.to).toBe('0xpm')
    // power + epochEnd target veReppo.
    expect(calls.find((c) => c.data.startsWith(SEL_POWER))!.to).toBe('0xve')
    expect(calls.find((c) => c.data.startsWith(SEL_EPOCH_END))!.data).toBe(SEL_EPOCH_END + word(117n))
  })

  it('floors remaining at 0n when casted exceeds power (mid-epoch power decay)', async () => {
    const f = fakeFetch((data) => {
      if (data.startsWith(SEL_EPOCH_END)) return 2_000n
      if (data.startsWith(SEL_EPOCH)) return 5n
      if (data.startsWith(SEL_POWER)) return 10n * REPPO
      if (data.startsWith(SEL_CASTED)) return 12n * REPPO
      return 0n
    })
    const out = await queryVotePowerBudget('http://rpc', WALLET, { fetchImpl: f })
    expect(out.remainingWei).toBe(0n)
  })

  it('throws (never zero-fills) on an RPC error', async () => {
    const f = (async () => ({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'over rate limit' } }),
    })) as unknown as typeof fetch
    await expect(queryVotePowerBudget('http://rpc', WALLET, { fetchImpl: f })).rejects.toThrow(/over rate limit/)
  })
})
