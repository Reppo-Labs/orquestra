import { describe, it, expect } from 'vitest'
import { tokenIdFromLog, discoverOwnedPods, queryClaimableOnchain, type PodCache } from './emissionsOnchain.js'

// Minimal JSON-RPC mock: routes by method + decodes the selector/args we care about.
const SEL = { hasClaimed: '0x5b778a36', claim: '0x6dd6f4c9', currentEpoch: '0x76671808' }
const w = (v: number | bigint) => BigInt(v).toString(16).padStart(64, '0')

function makeFetch(opts: {
  block?: bigint
  logs?: { topics: string[]; data: string }[]
  epoch: number
  claimed?: Set<string>     // `${epoch}:${podId}` already claimed
  claimable?: Set<string>   // `${podId}:${epoch}` whose claim does NOT revert
}): typeof fetch {
  const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  const revert = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'execution reverted' } }))
  return (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body)
    if (method === 'eth_blockNumber') return reply('0x' + (opts.block ?? 1000n).toString(16))
    if (method === 'eth_getLogs') return reply(opts.logs ?? [])
    if (method === 'eth_call') {
      const data: string = params[0].data
      const sel = data.slice(0, 10)
      if (sel === SEL.currentEpoch) return reply('0x' + w(opts.epoch))
      if (sel === SEL.hasClaimed) {
        const epoch = BigInt('0x' + data.slice(10, 74)), podId = BigInt('0x' + data.slice(74, 138))
        return reply('0x' + w(opts.claimed?.has(`${epoch}:${podId}`) ? 1 : 0))
      }
      if (sel === SEL.claim) {
        const podId = BigInt('0x' + data.slice(10, 74)), epoch = BigInt('0x' + data.slice(74, 138))
        return opts.claimable?.has(`${podId}:${epoch}`) ? reply('0x') : revert()
      }
    }
    return reply('0x')
  }) as unknown as typeof fetch
}

function memCache(initial: string[] = [], lastBlock: bigint | null = null): PodCache {
  const pods = new Set(initial); let lb = lastBlock
  return {
    getKnownPods: () => [...pods],
    addPods: (ids) => ids.forEach((i) => pods.add(i)),
    getLastBlock: () => lb,
    setLastBlock: (b) => { lb = b },
  }
}

const WALLET = '0xb4EC41c93cF2f573f82D8F023B01637Eb5dB4c64'
const log = (tokenId: number) => ({ topics: ['0xtransfer', '0x' + w(0), '0x' + w(0), '0x' + w(tokenId)], data: '0x' })

describe('tokenIdFromLog', () => {
  it('reads tokenId from the 3rd indexed topic', () => {
    expect(tokenIdFromLog(log(987))).toBe(987n)
  })
})

describe('discoverOwnedPods', () => {
  it('collects unique tokenIds from Transfer logs across chunks', async () => {
    const f = makeFetch({ logs: [log(1), log(2), log(2)], epoch: 100 })
    const ids = await discoverOwnedPods(f, 'http://rpc', '0xpm', WALLET, 0n, 100n)
    expect(ids.sort()).toEqual([1n, 2n])
  })
})

describe('queryClaimableOnchain', () => {
  it('returns only unclaimed + non-reverting (pod,epoch) pairs', async () => {
    // epoch 103; pods 5 & 7 known. 5@100 & 5@102 claimable, 5@101 already claimed,
    // pod 7 reverts everywhere (nothing due).
    const f = makeFetch({
      epoch: 103,
      claimed: new Set(['101:5']),
      claimable: new Set(['5:102', '5:100']),
    })
    const cache = memCache(['5', '7'], 999n) // lastBlock set → no re-discovery
    const out = await queryClaimableOnchain('http://rpc', WALLET, cache, { fetchImpl: f, lookbackEpochs: 3 })
    expect(out.map((o) => `${o.podId}:${o.epoch}`).sort()).toEqual(['5:100', '5:102'])
    expect(out.every((o) => o.reppo === 0 && o.datanetId === '')).toBe(true)
  })

  it('discovers new pods from logs when the cache has no checkpoint, then scans them', async () => {
    const f = makeFetch({ block: 50n, logs: [log(42)], epoch: 102, claimable: new Set(['42:101']) })
    const cache = memCache([], null)
    const out = await queryClaimableOnchain('http://rpc', WALLET, cache, { fetchImpl: f, lookbackEpochs: 2 })
    expect(cache.getKnownPods()).toContain('42')
    expect(cache.getLastBlock()).toBe(50n)
    expect(out.map((o) => `${o.podId}:${o.epoch}`)).toEqual(['42:101'])
  })

  it('returns nothing when all candidates are claimed or revert', async () => {
    const f = makeFetch({ epoch: 103, claimed: new Set(['102:5', '101:5', '100:5']) })
    const out = await queryClaimableOnchain('http://rpc', WALLET, memCache(['5'], 1n), { fetchImpl: f })
    expect(out).toEqual([])
  })
})
