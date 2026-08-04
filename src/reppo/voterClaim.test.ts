import { describe, it, expect, beforeEach } from 'vitest'
import { queryVoterClaimableOnchain, type VoterScanCache } from './emissionsOnchain.js'
import { MULTICALL3_ADDRESS, resetMulticallAvailabilityCache } from './multicall.js'

const SEL = {
  currentEpoch: '0x76671808',
  hasVoterClaimed: '0xec1e3908',
  claimVoter: '0x971a6c50',
  votesCasted: '0x3827cb73',
  voterUp: '0x08856f83',
  voterDown: '0x8c03a3e7',
}
const W = '0x00000000000000000000000000000000000000aa'
const word = (v: bigint) => v.toString(16).padStart(64, '0')
const uint = (n: bigint) => '0x' + word(n)
const TRUE = '0x' + word(1n)
const FALSE = '0x' + word(0n)

/** Fake JSON-RPC fetch.
 *  votedEpochs → votesCastedByVoterForEpoch > 0 (epoch-level: the wallet voted that epoch);
 *  votedPodEpochs (`${epoch}:${pod}`) → getVotersUp/DownVotesForPodInEpoch > 0 (per-pod gate);
 *  claimableEpochs (`${epoch}:${pod}`) → claimVoterEmissions does NOT revert (something due);
 *  claimed (`${epoch}:${pod}`) → hasUserClaimedEmissions true.
 *  Realistic invariant: claimable ⊆ votedPodEpochs (no reward without recorded votes). */
function fakeFetch(opts: {
  current: bigint
  votedEpochs: Set<number>
  votedPodEpochs: Set<string>
  claimableEpochs: Set<string>
  claimed?: Set<string>
}): typeof fetch {
  const calls = { claim: [] as string[], votesCasted: [] as number[], voterUp: [] as string[] }
  const f = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const { data } = body.params[0] as { to: string; data: string }
    const sel = data.slice(0, 10)
    if (sel === SEL.currentEpoch) return jsonOk(uint(opts.current))
    const args = data.slice(10)
    if (sel === SEL.votesCasted) {
      const epoch = Number(BigInt('0x' + args.slice(64, 128))) // voter, epoch
      calls.votesCasted.push(epoch)
      return jsonOk(opts.votedEpochs.has(epoch) ? uint(5n) : uint(0n))
    }
    if (sel === SEL.voterUp || sel === SEL.voterDown) {
      const epoch = BigInt('0x' + args.slice(0, 64)), pod = BigInt('0x' + args.slice(64, 128))
      const key = `${epoch}:${pod}`
      if (sel === SEL.voterUp) calls.voterUp.push(key)
      // model all weight on the up side
      return jsonOk(sel === SEL.voterUp && opts.votedPodEpochs.has(key) ? uint(5000000000000000000n) : uint(0n))
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

/** ABI-decode an aggregate3 REQUEST into its inner calls. */
function decodeAggregate3Request(data: string): { to: string; data: string }[] {
  const h = data.replace(/^0x/, '').slice(8) // strip selector
  const uintAt = (off: number) => Number(BigInt('0x' + h.slice(off * 2, off * 2 + 64)))
  const arr = uintAt(0)
  const n = uintAt(arr)
  const base = arr + 32
  const calls: { to: string; data: string }[] = []
  for (let i = 0; i < n; i++) {
    const el = base + uintAt(base + 32 * i)
    const to = '0x' + h.slice(el * 2 + 24, el * 2 + 64)
    const bytesAt = el + uintAt(el + 64)
    const len = uintAt(bytesAt)
    calls.push({ to, data: '0x' + h.slice((bytesAt + 32) * 2, (bytesAt + 32 + len) * 2) })
  }
  return calls
}

/** ABI-encode an aggregate3 RESULT: (bool success, bytes returnData)[]. */
function encodeAggregate3Result(results: { success: boolean; returnData: string }[]): string {
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

/** Make Multicall3 "deployed" over an existing fake fetch: answers the code probe, unpacks
 *  aggregate3 requests and routes every inner call through the inner fake — batched and
 *  serial paths therefore share the exact same per-selector fixtures. */
function mcWrap(inner: typeof fetch): typeof fetch & { _mc: { aggregates: number; directSelectors: string[] } } {
  const _mc = { aggregates: 0, directSelectors: [] as string[] }
  const f = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params?: [{ to?: string; data?: string }] }
    if (body.method === 'eth_getCode') return jsonOk('0x6080')
    const p0 = body.params?.[0]
    if (body.method === 'eth_call' && p0?.to?.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) {
      _mc.aggregates++
      const results: { success: boolean; returnData: string }[] = []
      for (const c of decodeAggregate3Request(p0.data ?? '')) {
        const r = await (inner as unknown as (u: string, i: { body: string }) => Promise<Response>)(
          url, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] }) })
        const j = (await r.json()) as { result?: string; error?: unknown }
        results.push(j.error ? { success: false, returnData: '0x' } : { success: true, returnData: j.result ?? '0x' })
      }
      return jsonOk(encodeAggregate3Result(results))
    }
    if (body.method === 'eth_call' && p0?.data) _mc.directSelectors.push(p0.data.slice(0, 10))
    return (inner as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init)
  }) as unknown as typeof fetch & { _mc: typeof _mc }
  f._mc = _mc
  return f
}

describe('queryVoterClaimableOnchain — multicall path', () => {
  beforeEach(() => resetMulticallAvailabilityCache())

  it('finds the same claimables as the serial path, batching gates and keeping claim probes serial', async () => {
    const opts = {
      current: 107n, votedEpochs: new Set([104, 105]), votedPodEpochs: new Set(['105:50', '104:51']),
      claimableEpochs: new Set(['105:50', '104:51']),
    }
    const serial = await queryVoterClaimableOnchain('rpc', W, ['50', '51'], undefined, { fetchImpl: fakeFetch(opts) })
    const mc = mcWrap(fakeFetch(opts))
    const batched = await queryVoterClaimableOnchain('rpc-mc', W, ['50', '51'], undefined, { fetchImpl: mc })
    expect(batched).toEqual(serial)
    expect(serial.map((e) => `${e.epoch}:${e.podId}`).sort()).toEqual(['104:51', '105:50'])
    expect(mc._mc.aggregates).toBe(2) // one votesCasted batch + one gate-grid batch
    // gates went through the aggregate; only currentEpoch and the msg.sender-dependent
    // claim probes were issued as direct eth_calls
    expect(mc._mc.directSelectors).not.toContain(SEL.votesCasted)
    expect(mc._mc.directSelectors).not.toContain(SEL.voterUp)
    expect(mc._mc.directSelectors).not.toContain(SEL.hasVoterClaimed)
    expect(mc._mc.directSelectors.filter((s) => s === SEL.claimVoter)).toHaveLength(2)
  })

  it('an inner gate failure reads as "not active / no votes", matching serial catch semantics', async () => {
    // votedEpochs empty → every votesCasted inner call returns 0 → no active epochs → no claims
    const mc = mcWrap(fakeFetch({ current: 107n, votedEpochs: new Set(), votedPodEpochs: new Set(), claimableEpochs: new Set() }))
    expect(await queryVoterClaimableOnchain('rpc-mc2', W, ['50'], undefined, { fetchImpl: mc })).toEqual([])
    expect(mc._mc.directSelectors).not.toContain(SEL.claimVoter) // nothing probed
  })
})

describe('queryVoterClaimableOnchain', () => {
  it('claims an active epoch where the wallet voted the pod and a reward is due', async () => {
    const f = fakeFetch({ current: 107n, votedEpochs: new Set([105]), votedPodEpochs: new Set(['105:50']), claimableEpochs: new Set(['105:50']) })
    const out = await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f })
    expect(out).toEqual([{ podId: '50', datanetId: '', epoch: 105, reppo: 0 }])
  })

  it('skips (no claim attempt) a pod the wallet did NOT vote in that epoch — only-claim-if-earning gate', async () => {
    // votesCasted>0 at 105 (wallet voted SOMETHING), but NOT this pod (votedPodEpochs empty).
    const f = fakeFetch({ current: 107n, votedEpochs: new Set([105]), votedPodEpochs: new Set(), claimableEpochs: new Set(['105:50']) })
    const calls = (f as unknown as { _calls: { claim: string[] } })._calls
    const out = await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f })
    expect(out).toEqual([])
    expect(calls.claim).toEqual([]) // never attempted the claim — pod had no recorded votes
  })

  it('skips epochs the wallet did NOT vote in at all (active-epoch gate, no per-pod probe)', async () => {
    const f = fakeFetch({ current: 107n, votedEpochs: new Set([105]), votedPodEpochs: new Set(['103:50']), claimableEpochs: new Set(['103:50']) })
    const calls = (f as unknown as { _calls: { claim: string[]; voterUp: string[] } })._calls
    const out = await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f })
    expect(out).toEqual([])                       // 103 not an active epoch → pruned
    expect(calls.voterUp.some((k) => k.startsWith('103:'))).toBe(false) // never even probed votes at 103
  })

  it('respects floorEpoch — never scans below it', async () => {
    const f = fakeFetch({ current: 107n, votedEpochs: new Set([95, 105]), votedPodEpochs: new Set(['95:50', '105:50']), claimableEpochs: new Set(['95:50', '105:50']) })
    const calls = (f as unknown as { _calls: { votesCasted: number[] } })._calls
    const out = await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f, floorEpoch: 100 })
    expect(out.map((e) => e.epoch)).toEqual([105])
    expect(Math.min(...calls.votesCasted)).toBe(100)
  })

  it('skips an earning epoch that is already claimed', async () => {
    const f = fakeFetch({
      current: 107n, votedEpochs: new Set([105]), votedPodEpochs: new Set(['105:50']),
      claimableEpochs: new Set(['105:50']), claimed: new Set(['105:50']),
    })
    expect(await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f })).toEqual([])
  })

  it('persists a watermark and does not re-scan resolved epochs next run', async () => {
    const store: Record<string, number> = {}
    const cache: VoterScanCache = { getThrough: (p) => store[p] ?? 0, setThrough: (p, e) => { store[p] = e } }
    const f1 = fakeFetch({ current: 107n, votedEpochs: new Set([104]), votedPodEpochs: new Set(), claimableEpochs: new Set() })
    expect(await queryVoterClaimableOnchain('rpc', W, ['50'], cache, { fetchImpl: f1 })).toEqual([])
    expect(store['50']).toBe(106) // through last closed epoch (nothing due)
    const f2 = fakeFetch({ current: 107n, votedEpochs: new Set([104]), votedPodEpochs: new Set(['104:50']), claimableEpochs: new Set(['104:50']) })
    const calls2 = (f2 as unknown as { _calls: { claim: string[] } })._calls
    await queryVoterClaimableOnchain('rpc', W, ['50'], cache, { fetchImpl: f2 })
    expect(calls2.claim).toEqual([]) // below the watermark → not re-scanned
  })

  it('does NOT advance the watermark past a still-claimable (unclaimed) epoch', async () => {
    const store: Record<string, number> = {}
    const cache: VoterScanCache = { getThrough: (p) => store[p] ?? 0, setThrough: (p, e) => { store[p] = e } }
    const f = fakeFetch({ current: 107n, votedEpochs: new Set([103]), votedPodEpochs: new Set(['103:50']), claimableEpochs: new Set(['103:50']) })
    const out = await queryVoterClaimableOnchain('rpc', W, ['50'], cache, { fetchImpl: f })
    expect(out.map((e) => e.epoch)).toEqual([103])
    expect(store['50']).toBe(102)
  })

  it('returns [] when there are no closed epochs yet', async () => {
    const f = fakeFetch({ current: 1n, votedEpochs: new Set(), votedPodEpochs: new Set(), claimableEpochs: new Set() })
    expect(await queryVoterClaimableOnchain('rpc', W, ['50'], undefined, { fetchImpl: f })).toEqual([])
  })
})
