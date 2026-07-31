import { describe, it, expect } from 'vitest'
import { tokenIdFromLog, discoverOwnedPods, queryClaimableOnchain, type PodCache, type EpochScanCache } from './emissionsOnchain.js'

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

const WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
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

  it('keeps every eth_getLogs span under the ~10k public-RPC cap (no HTTP 400)', async () => {
    // Operator hit HTTP 400 because the old 40k chunk exceeded mainnet.base.org's getLogs
    // limit. Capture each requested [fromBlock,toBlock] span over a wide range and assert none
    // exceeds 10_000 blocks — and that the whole range is covered with no gaps/overlaps.
    const spans: Array<[bigint, bigint]> = []
    const f = (async (_url: string, init: { body: string }) => {
      const { method, params } = JSON.parse(init.body)
      if (method === 'eth_getLogs') {
        spans.push([BigInt(params[0].fromBlock), BigInt(params[0].toBlock)])
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }))
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }))
    }) as unknown as typeof fetch

    await discoverOwnedPods(f, 'http://rpc', '0xpm', WALLET, 0n, 100_000n)

    expect(spans.length).toBeGreaterThan(1) // 100k blocks must be chunked
    for (const [from, to] of spans) expect(to - from + 1n).toBeLessThanOrEqual(10_000n)
    expect(spans[0][0]).toBe(0n)                                  // starts at fromBlock
    expect(spans[spans.length - 1][1]).toBe(100_000n)            // ends at toBlock
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBe(spans[i - 1][1] + 1n) // contiguous
  })
})

describe('discoverOwnedPods — adaptive chunk (provider caps below our default)', () => {
  /** Fetch that 400s any span wider than `cap` blocks — models free-tier RPCs
   *  (several cap eth_getLogs at 1k-5k; our default chunk is 9k). */
  const cappingFetch = (cap: bigint, spans: Array<[bigint, bigint]>) => (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body)
    if (method === 'eth_getLogs') {
      const from = BigInt(params[0].fromBlock), to = BigInt(params[0].toBlock)
      if (to - from + 1n > cap) return new Response('range too large', { status: 400 })
      spans.push([from, to])
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }))
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }))
  }) as unknown as typeof fetch

  it('halves the chunk on a range-cap 400 and completes the scan', async () => {
    const spans: Array<[bigint, bigint]> = []
    await discoverOwnedPods(cappingFetch(2_000n, spans), 'http://rpc', '0xpm', WALLET, 0n, 30_000n)
    expect(spans.length).toBeGreaterThan(0)
    for (const [from, to] of spans) expect(to - from + 1n).toBeLessThanOrEqual(2_000n)
    // full, contiguous coverage despite the shrink
    expect(spans[0][0]).toBe(0n)
    expect(spans[spans.length - 1][1]).toBe(30_000n)
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBe(spans[i - 1][1] + 1n)
  })

  it('remembers the reduced chunk within the same scan (no re-probing every window)', async () => {
    const attempts: bigint[] = []
    const f = (async (_url: string, init: { body: string }) => {
      const { method, params } = JSON.parse(init.body)
      if (method === 'eth_getLogs') {
        const span = BigInt(params[0].toBlock) - BigInt(params[0].fromBlock) + 1n
        attempts.push(span)
        if (span > 2_000n) return new Response('range too large', { status: 400 })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }))
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }))
    }) as unknown as typeof fetch
    await discoverOwnedPods(f, 'http://rpc', '0xpm', WALLET, 0n, 50_000n)
    // over-cap attempts happen only during the initial shrink, not once per window
    expect(attempts.filter((s) => s > 2_000n).length).toBeLessThanOrEqual(4)
  })

  it('gives up (throws) when even the minimum chunk is rejected — no infinite loop', async () => {
    const f = (async (_url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body)
      if (method === 'eth_getLogs') return new Response('nope', { status: 400 })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }))
    }) as unknown as typeof fetch
    await expect(discoverOwnedPods(f, 'http://rpc', '0xpm', WALLET, 0n, 30_000n)).rejects.toThrow(/HTTP 400/)
  })

  it('does NOT shrink-and-retry on non-range transient failures (5xx propagates untouched)', async () => {
    let calls = 0
    const f = (async (_url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body)
      if (method === 'eth_getLogs') { calls++; return new Response('down', { status: 503 }) }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }))
    }) as unknown as typeof fetch
    await expect(discoverOwnedPods(f, 'http://rpc', '0xpm', WALLET, 0n, 30_000n)).rejects.toThrow(/HTTP 503/)
    expect(calls).toBe(1) // transient outage: fail fast for the caller's own retry-next-cycle
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

function memScanCache(initial: Record<string, number> = {}): EpochScanCache & { state: Record<string, number> } {
  const state = { ...initial }
  return {
    state,
    getThrough: (podId) => state[podId] ?? 0,
    setThrough: (podId, epoch) => { state[podId] = epoch },
  }
}

describe('queryClaimableOnchain with an epoch-scan watermark', () => {
  it('first run deep-scans from floorEpoch, not just the last 3 epochs', async () => {
    // Backlog at epoch 90 — far outside the legacy 3-epoch window at epoch 103. The
    // operator-reported bug: the node could never see it, only a manual claim could.
    const f = makeFetch({ epoch: 103, claimable: new Set(['5:90', '5:102']) })
    const scan = memScanCache()
    const out = await queryClaimableOnchain('http://rpc', WALLET, memCache(['5'], 1n), { fetchImpl: f, floorEpoch: 80 }, scan)
    expect(out.map((o) => `${o.podId}:${o.epoch}`).sort()).toEqual(['5:102', '5:90'])
  })

  it('advances the watermark to just before the oldest still-claimable epoch', async () => {
    const f = makeFetch({ epoch: 103, claimable: new Set(['5:90']) })
    const scan = memScanCache()
    await queryClaimableOnchain('http://rpc', WALLET, memCache(['5'], 1n), { fetchImpl: f, floorEpoch: 80 }, scan)
    // 90 is claimable-but-unclaimed: must stay re-checkable until hasClaimed flips true.
    expect(scan.state['5']).toBe(89)
  })

  it('advances the watermark to the last closed epoch when nothing is due', async () => {
    const f = makeFetch({ epoch: 103 })
    const scan = memScanCache()
    await queryClaimableOnchain('http://rpc', WALLET, memCache(['5'], 1n), { fetchImpl: f, floorEpoch: 80 }, scan)
    expect(scan.state['5']).toBe(102)
  })

  it('resumes past the watermark instead of re-scanning old epochs', async () => {
    const calls: string[] = []
    const inner = makeFetch({ epoch: 103, claimable: new Set(['5:102']) })
    const f = (async (url: string, init: { body: string }) => {
      const { method, params } = JSON.parse(init.body)
      if (method === 'eth_call') calls.push(params[0].data.slice(0, 10))
      return inner(url, init as never)
    }) as unknown as typeof fetch
    const scan = memScanCache({ '5': 101 })
    const out = await queryClaimableOnchain('http://rpc', WALLET, memCache(['5'], 1n), { fetchImpl: f, floorEpoch: 1 }, scan)
    expect(out.map((o) => `${o.podId}:${o.epoch}`)).toEqual(['5:102'])
    // Only epoch 102 is checked: 1 hasClaimed + 1 claim probe (+ 1 currentEpoch read).
    expect(calls.filter((s) => s === SEL.hasClaimed)).toHaveLength(1)
  })

  it('keeps the legacy lookback window when no watermark cache is given', async () => {
    // Without a scan cache the behavior is unchanged: epoch 90 stays invisible.
    const f = makeFetch({ epoch: 103, claimable: new Set(['5:90', '5:102']) })
    const out = await queryClaimableOnchain('http://rpc', WALLET, memCache(['5'], 1n), { fetchImpl: f, lookbackEpochs: 3 })
    expect(out.map((o) => `${o.podId}:${o.epoch}`)).toEqual(['5:102'])
  })
})

describe('queryClaimableOnchain — transient RPC error vs contract revert', () => {
  // Wrap makeFetch so a specific claim probe fails a chosen way instead of reverting. A
  // contract revert = "nothing due" (skip); a transient failure must NOT be read that way.
  const withClaimFailure = (
    base: typeof fetch,
    failFor: Set<string>,
    fail: () => Response,
  ): typeof fetch => (async (url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body)
    if (method === 'eth_call') {
      const d: string = params[0].data
      if (d.slice(0, 10) === SEL.claim) {
        const podId = BigInt('0x' + d.slice(10, 74)), epoch = BigInt('0x' + d.slice(74, 138))
        if (failFor.has(`${podId}:${epoch}`)) return fail()
      }
    }
    return base(url as never, init as never)
  }) as unknown as typeof fetch

  const http500 = () => new Response('upstream error', { status: 500 })
  const rateLimited = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limit exceeded' } }))

  it('propagates a transient (HTTP 5xx) claim-probe error instead of skipping the epoch', async () => {
    // Epoch 90 is genuinely claimable but its probe hits a 5xx. Before the fix this was
    // swallowed as "nothing due"; now it must throw so the epoch is not lost.
    const base = makeFetch({ epoch: 103, claimable: new Set(['5:90']) })
    const f = withClaimFailure(base, new Set(['5:90']), http500)
    const scan = memScanCache()
    await expect(
      queryClaimableOnchain('http://rpc', WALLET, memCache(['5'], 1n), { fetchImpl: f, floorEpoch: 80 }, scan),
    ).rejects.toThrow()
    // Watermark must NOT advance past the un-probed epoch — it stays re-checkable next cycle.
    expect(scan.state['5']).toBeUndefined()
  })

  it('propagates a transient JSON-RPC error (rate limit) — not treated as nothing-due', async () => {
    const base = makeFetch({ epoch: 103, claimable: new Set(['5:90']) })
    const f = withClaimFailure(base, new Set(['5:90']), rateLimited)
    const scan = memScanCache()
    await expect(
      queryClaimableOnchain('http://rpc', WALLET, memCache(['5'], 1n), { fetchImpl: f, floorEpoch: 80 }, scan),
    ).rejects.toThrow()
    expect(scan.state['5']).toBeUndefined()
  })

  it('still treats a genuine contract revert as nothing-due and advances the watermark', async () => {
    // No claim is claimable → every probe reverts → clean scan, watermark to last closed epoch.
    const f = makeFetch({ epoch: 103 })
    const scan = memScanCache()
    const out = await queryClaimableOnchain('http://rpc', WALLET, memCache(['5'], 1n), { fetchImpl: f, floorEpoch: 80 }, scan)
    expect(out).toEqual([])
    expect(scan.state['5']).toBe(102)
  })

  it('propagates a transient error in legacy (no-watermark) mode too', async () => {
    const base = makeFetch({ epoch: 103, claimable: new Set(['5:102']) })
    const f = withClaimFailure(base, new Set(['5:102']), http500)
    await expect(
      queryClaimableOnchain('http://rpc', WALLET, memCache(['5'], 1n), { fetchImpl: f, lookbackEpochs: 3 }),
    ).rejects.toThrow()
  })
})
