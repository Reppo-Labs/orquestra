import { describe, it, expect } from 'vitest'
import { queryVoterClaimableOnchain, type VoterScanCache } from './emissionsOnchain.js'

// Selectors under test (from emissionsOnchain SEL).
const SEL = {
  currentEpoch: '0x76671808',
  hasVoterClaimed: '0xec1e3908',
  claimVoter: '0x971a6c50',
  voterUp: '0x08856f83',
  voterDown: '0x8c03a3e7',
}
const W = '0x00000000000000000000000000000000000000aa'
const word = (v: bigint) => v.toString(16).padStart(64, '0')
const uint = (n: bigint) => '0x' + word(n)
const TRUE = '0x' + word(1n)
const FALSE = '0x' + word(0n)

/** Build a fake JSON-RPC fetch. votes keyed `${epoch}:${pod}` → [up,down]; claimableEpochs →
 *  claimVoter eth_call doesn't revert; claimed → hasUserClaimedEmissions true. */
function fakeFetch(opts: {
  current: bigint
  votes: Record<string, [bigint, bigint]>
  claimableEpochs: Set<string>
  claimed?: Set<string>
}): typeof fetch {
  const calls = { claim: [] as string[] }
  const f = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const { data } = body.params[0] as { to: string; data: string }
    const sel = data.slice(0, 10)
    if (sel === SEL.currentEpoch) return jsonOk(uint(opts.current))
    const args = data.slice(10)
    const a0 = BigInt('0x' + args.slice(0, 64))
    const a1 = BigInt('0x' + args.slice(64, 128))
    if (sel === SEL.voterUp || sel === SEL.voterDown) {
      const [up, down] = opts.votes[`${a0}:${a1}`] ?? [0n, 0n] // epoch:pod
      return jsonOk(uint(sel === SEL.voterUp ? up : down))
    }
    if (sel === SEL.hasVoterClaimed) {
      return jsonOk(opts.claimed?.has(`${a0}:${a1}`) ? TRUE : FALSE) // epoch:pod
    }
    if (sel === SEL.claimVoter) {
      const pod = BigInt('0x' + args.slice(64, 128))
      const epoch = BigInt('0x' + args.slice(128, 192))
      const key = `${epoch}:${pod}`
      calls.claim.push(key)
      return opts.claimableEpochs.has(key) ? jsonOk('0x') : jsonErr('execution reverted')
    }
    return jsonOk('0x')
  }) as unknown as typeof fetch
  ;(f as unknown as { _calls: typeof calls })._calls = calls
  return f
}
const jsonOk = (result: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
const jsonErr = (message: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message } }), { status: 200 })

describe('queryVoterClaimableOnchain', () => {
  it('claims only epochs where the wallet has counted votes (no 0-claims)', async () => {
    const f = fakeFetch({ current: 107n, votes: { '105:50': [10n, 0n] }, claimableEpochs: new Set(['105:50']) })
    const out = await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f })
    expect(out).toEqual([{ podId: '50', datanetId: '', epoch: 105, reppo: 0 }])
  })

  it('skips an epoch with votes but already claimed', async () => {
    const f = fakeFetch({
      current: 107n, votes: { '105:50': [10n, 0n] },
      claimableEpochs: new Set(['105:50']), claimed: new Set(['105:50']),
    })
    expect(await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f })).toEqual([])
  })

  it('persists a watermark and does not re-scan resolved epochs next run', async () => {
    const store: Record<string, number> = {}
    const cache: VoterScanCache = { getThrough: (p) => store[p] ?? 0, setThrough: (p, e) => { store[p] = e } }
    const f1 = fakeFetch({ current: 107n, votes: {}, claimableEpochs: new Set() })
    expect(await queryVoterClaimableOnchain('rpc', W, ['50'], cache, { fetchImpl: f1 })).toEqual([])
    expect(store['50']).toBe(106) // scanned through last closed epoch (nothing due)
    const f2 = fakeFetch({ current: 107n, votes: { '50:50': [9n, 0n] }, claimableEpochs: new Set() })
    const calls2 = (f2 as unknown as { _calls: { claim: string[] } })._calls
    await queryVoterClaimableOnchain('rpc', W, ['50'], cache, { fetchImpl: f2 })
    expect(calls2.claim).toEqual([]) // nothing re-scanned below the watermark
  })

  it('does NOT advance the watermark past a still-claimable (unclaimed) epoch', async () => {
    const store: Record<string, number> = {}
    const cache: VoterScanCache = { getThrough: (p) => store[p] ?? 0, setThrough: (p, e) => { store[p] = e } }
    const f = fakeFetch({ current: 107n, votes: { '103:50': [5n, 0n] }, claimableEpochs: new Set(['103:50']) })
    const out = await queryVoterClaimableOnchain('rpc', W, ['50'], cache, { fetchImpl: f })
    expect(out.map((e) => e.epoch)).toEqual([103])
    expect(store['50']).toBe(102) // just before the oldest still-claimable epoch
  })

  it('returns [] when there are no closed epochs yet', async () => {
    const f = fakeFetch({ current: 1n, votes: {}, claimableEpochs: new Set() })
    expect(await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f })).toEqual([])
  })
})
