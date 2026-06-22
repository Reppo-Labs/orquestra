import { describe, it, expect } from 'vitest'
import { queryVoterClaimableOnchain, type VoterScanCache } from './emissionsOnchain.js'

const SEL = {
  currentEpoch: '0x76671808',
  hasVoterClaimed: '0xec1e3908',
  claimVoter: '0x971a6c50',
  votesCasted: '0x3827cb73',
}
const W = '0x00000000000000000000000000000000000000aa'
const word = (v: bigint) => v.toString(16).padStart(64, '0')
const uint = (n: bigint) => '0x' + word(n)
const TRUE = '0x' + word(1n)
const FALSE = '0x' + word(0n)

/** Fake JSON-RPC fetch.
 *  votedEpochs → votesCastedByVoterForEpoch > 0 (the wallet voted that epoch);
 *  claimableEpochs (`${epoch}:${pod}`) → claimVoterEmissions does NOT revert (something due);
 *  claimed (`${epoch}:${pod}`) → hasUserClaimedEmissions true. */
function fakeFetch(opts: {
  current: bigint
  votedEpochs: Set<number>
  claimableEpochs: Set<string>
  claimed?: Set<string>
}): typeof fetch {
  const calls = { claim: [] as string[], votesCasted: [] as number[] }
  const f = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const { data } = body.params[0] as { to: string; data: string }
    const sel = data.slice(0, 10)
    if (sel === SEL.currentEpoch) return jsonOk(uint(opts.current))
    const args = data.slice(10)
    if (sel === SEL.votesCasted) {
      // votesCastedByVoterForEpoch(voter, epoch): voter word, epoch word
      const epoch = Number(BigInt('0x' + args.slice(64, 128)))
      calls.votesCasted.push(epoch)
      return jsonOk(opts.votedEpochs.has(epoch) ? uint(5n) : uint(0n))
    }
    if (sel === SEL.hasVoterClaimed) {
      const epoch = BigInt('0x' + args.slice(0, 64)), pod = BigInt('0x' + args.slice(64, 128))
      return jsonOk(opts.claimed?.has(`${epoch}:${pod}`) ? TRUE : FALSE)
    }
    if (sel === SEL.claimVoter) {
      const pod = BigInt('0x' + args.slice(64, 128)), epoch = BigInt('0x' + args.slice(128, 192))
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
  it('claims an active+due epoch (votesCasted>0, claim does not revert)', async () => {
    const f = fakeFetch({ current: 107n, votedEpochs: new Set([105]), claimableEpochs: new Set(['105:50']) })
    const out = await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f })
    expect(out).toEqual([{ podId: '50', datanetId: '', epoch: 105, reppo: 0 }])
  })

  it('skips epochs the wallet did NOT vote in (active-epoch gate prunes the claim attempt)', async () => {
    // "due" at 103 BUT wallet didn't vote at 103 → must NEVER attempt the claim there.
    const f = fakeFetch({ current: 107n, votedEpochs: new Set([105]), claimableEpochs: new Set(['103:50']) })
    const calls = (f as unknown as { _calls: { claim: string[] } })._calls
    const out = await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f })
    expect(out).toEqual([])                       // 103 pruned → nothing claimable
    expect(calls.claim).not.toContain('103:50')   // never attempted the claim at the unvoted epoch
    expect(calls.claim).toEqual(['105:50'])        // only the active epoch was probed (and it reverted)
  })

  it('respects floorEpoch — never scans below it', async () => {
    const f = fakeFetch({ current: 107n, votedEpochs: new Set([95, 105]), claimableEpochs: new Set(['95:50', '105:50']) })
    const calls = (f as unknown as { _calls: { votesCasted: number[] } })._calls
    const out = await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f, floorEpoch: 100 })
    expect(out.map((e) => e.epoch)).toEqual([105])     // 95 below floor → not claimed
    expect(Math.min(...calls.votesCasted)).toBe(100)   // never probed below 100
  })

  it('skips an active+due epoch that is already claimed', async () => {
    const f = fakeFetch({
      current: 107n, votedEpochs: new Set([105]),
      claimableEpochs: new Set(['105:50']), claimed: new Set(['105:50']),
    })
    expect(await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f })).toEqual([])
  })

  it('persists a watermark and does not re-scan resolved epochs next run', async () => {
    const store: Record<string, number> = {}
    const cache: VoterScanCache = { getThrough: (p) => store[p] ?? 0, setThrough: (p, e) => { store[p] = e } }
    const f1 = fakeFetch({ current: 107n, votedEpochs: new Set([104]), claimableEpochs: new Set() }) // active but nothing due
    expect(await queryVoterClaimableOnchain('rpc', W, ['50'], cache, { fetchImpl: f1 })).toEqual([])
    expect(store['50']).toBe(106) // through last closed epoch (nothing due)
    const f2 = fakeFetch({ current: 107n, votedEpochs: new Set([104]), claimableEpochs: new Set(['104:50']) })
    const calls2 = (f2 as unknown as { _calls: { claim: string[] } })._calls
    await queryVoterClaimableOnchain('rpc', W, ['50'], cache, { fetchImpl: f2 })
    expect(calls2.claim).toEqual([]) // below the watermark → not re-scanned
  })

  it('does NOT advance the watermark past a still-claimable (unclaimed) epoch', async () => {
    const store: Record<string, number> = {}
    const cache: VoterScanCache = { getThrough: (p) => store[p] ?? 0, setThrough: (p, e) => { store[p] = e } }
    const f = fakeFetch({ current: 107n, votedEpochs: new Set([103]), claimableEpochs: new Set(['103:50']) })
    const out = await queryVoterClaimableOnchain('rpc', W, ['50'], cache, { fetchImpl: f })
    expect(out.map((e) => e.epoch)).toEqual([103])
    expect(store['50']).toBe(102) // just before the oldest still-claimable epoch
  })

  it('returns [] when there are no closed epochs yet', async () => {
    const f = fakeFetch({ current: 1n, votedEpochs: new Set(), claimableEpochs: new Set() })
    expect(await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f })).toEqual([])
  })
})
