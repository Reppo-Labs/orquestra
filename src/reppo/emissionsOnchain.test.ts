import { describe, it, expect, beforeEach } from 'vitest'
import { tokenIdFromLog, discoverOwnedPods, queryClaimableOnchain, type PodCache, type EpochScanCache } from './emissionsOnchain.js'
import { MULTICALL3_ADDRESS, resetMulticallAvailabilityCache } from './multicall.js'

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

/** ABI helpers + a wrapper that makes Multicall3 "deployed" over an existing fake fetch:
 *  aggregate3 requests are unpacked and every inner call routed through the inner fake, so
 *  batched and serial paths share the exact same per-selector fixtures (voterClaim.test.ts
 *  pattern). */
function decodeAggregate3Request(data: string): { to: string; data: string }[] {
  const h = data.replace(/^0x/, '').slice(8)
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

function encodeAggregate3Result(results: { success: boolean; returnData: string }[]): string {
  const heads: string[] = []
  const tails: string[] = []
  let off = 32 * results.length
  for (const r of results) {
    heads.push(w(BigInt(off)))
    const data = r.returnData.replace(/^0x/, '')
    const padded = data.length % 64 === 0 ? data : data + '0'.repeat(64 - (data.length % 64))
    const elem = w(r.success ? 1 : 0) + w(0x40) + w(data.length / 2) + padded
    tails.push(elem)
    off += elem.length / 2
  }
  return '0x' + w(0x20) + w(results.length) + heads.join('') + tails.join('')
}

function mcWrap(inner: typeof fetch): typeof fetch & { _mc: { aggregates: number; directSelectors: string[] } } {
  const _mc = { aggregates: 0, directSelectors: [] as string[] }
  const reply = (result: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  const f = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { method: string; params?: [{ to?: string; data?: string }] }
    if (body.method === 'eth_getCode') return reply('0x6080')
    const p0 = body.params?.[0]
    if (body.method === 'eth_call' && typeof p0 === 'object' && p0?.to?.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) {
      _mc.aggregates++
      const results: { success: boolean; returnData: string }[] = []
      for (const c of decodeAggregate3Request(p0.data ?? '')) {
        const r = await (inner as unknown as (u: string, i: { body: string }) => Promise<Response>)(
          url, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] }) })
        const j = (await r.json()) as { result?: string; error?: unknown }
        results.push(j.error ? { success: false, returnData: '0x' } : { success: true, returnData: j.result ?? '0x' })
      }
      return reply(encodeAggregate3Result(results))
    }
    if (body.method === 'eth_call' && typeof p0 === 'object' && p0?.data) _mc.directSelectors.push(p0.data.slice(0, 10))
    return (inner as unknown as (u: string, i: { body: string }) => Promise<Response>)(url, init)
  }) as unknown as typeof fetch & { _mc: typeof _mc }
  f._mc = _mc
  return f
}

describe('queryClaimableOnchain — multicall path', () => {
  beforeEach(() => resetMulticallAvailabilityCache())

  it('finds the same claimables as the serial path, batching hasClaimed and keeping claim probes serial', async () => {
    const opts = { epoch: 103, claimed: new Set(['100:5']), claimable: new Set(['5:101', '5:102']) }
    const serial = await queryClaimableOnchain('http://rpc', WALLET, memCache(['5'], 1n), {
      fetchImpl: makeFetch(opts), lookbackEpochs: 3,
    })
    const mc = mcWrap(makeFetch(opts))
    const batched = await queryClaimableOnchain('http://rpc-mc', WALLET, memCache(['5'], 1n), {
      fetchImpl: mc, lookbackEpochs: 3,
    })
    expect(batched).toEqual(serial)
    expect(serial.map((e) => e.epoch).sort()).toEqual([101, 102])
    expect(mc._mc.aggregates).toBe(1) // the whole hasClaimed grid in one request
    expect(mc._mc.directSelectors).not.toContain(SEL.hasClaimed) // status reads all batched
    expect(mc._mc.directSelectors.filter((s) => s === SEL.claim)).toHaveLength(2) // probes stay serial; epoch 100 skipped as claimed
  })
})

describe('rpcCall — the provider explanation reaches the operator', () => {
  /** Fetch that answers eth_getLogs with a given HTTP status + body, and every other
   *  method normally, so a scan reaches the getLogs call before failing. */
  const failingLogs = (status: number, body: string) => (async (_url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body)
    if (method === 'eth_getLogs') return new Response(body, { status })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }))
  }) as unknown as typeof fetch

  it('carries the provider body on an HTTP error, not just the status', async () => {
    // The whole point: two operators reported a bare "eth_getLogs HTTP 400" and the
    // provider's own sentence — the only thing that says WHICH limit was hit — was dropped.
    const f = failingLogs(400, '{"error":{"message":"eth_getLogs is limited to a 10,000 range"}}')
    await expect(discoverOwnedPods(f, 'http://rpc', '0xpm', WALLET, 0n, 30_000n))
      .rejects.toThrow(/limited to a 10,000 range/)
  })

  it('still names the status when the body is empty (no regression on the old message)', async () => {
    const f = failingLogs(400, '')
    await expect(discoverOwnedPods(f, 'http://rpc', '0xpm', WALLET, 0n, 30_000n)).rejects.toThrow(/HTTP 400/)
  })

  it('truncates a huge body so an HTML error page cannot flood the log or dashboard row', async () => {
    const f = failingLogs(400, '<html>' + 'x'.repeat(5_000) + '</html>')
    const err = await discoverOwnedPods(f, 'http://rpc', '0xpm', WALLET, 0n, 30_000n).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message.length).toBeLessThan(400)
  })

  it('redacts a provider key echoed back in the body (this string reaches the dashboard)', async () => {
    // Providers routinely quote the request URL back in an error; the path holds the key.
    const f = failingLogs(401, 'bad key for https://base-mainnet.g.alchemy.com/v2/SUPERSECRETKEY123')
    const err = await discoverOwnedPods(f, 'http://rpc', '0xpm', WALLET, 0n, 30_000n).catch((e: Error) => e)
    expect((err as Error).message).not.toContain('SUPERSECRETKEY123')
  })
})

describe('discoverOwnedPods — a 400 that halving cannot fix fails fast', () => {
  /** Counts getLogs attempts so we can prove the scan did NOT burn the 5-step shrink. */
  const countingFetch = (body: string, status = 400) => {
    const attempts: bigint[] = []
    const f = (async (_url: string, init: { body: string }) => {
      const { method, params } = JSON.parse(init.body)
      if (method === 'eth_getLogs') {
        attempts.push(BigInt(params[0].toBlock) - BigInt(params[0].fromBlock) + 1n)
        return new Response(body, { status })
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }))
    }) as unknown as typeof fetch
    return { f, attempts }
  }

  it('does not shrink on an archive-tier 400 — the depth is refused, not the width', async () => {
    // Halving answers "your range is too WIDE". It cannot answer "you may not read blocks
    // this OLD", which is what a free tier says to the first-run ~4M-block lookback.
    const { f, attempts } = countingFetch('{"error":{"message":"Archive requests require a paid plan"}}')
    await expect(discoverOwnedPods(f, 'http://rpc', '0xpm', WALLET, 0n, 30_000n)).rejects.toThrow(/Archive/)
    expect(attempts).toHaveLength(1) // one attempt, then out — no 9000→500 shrink
  })

  it('does not shrink on an auth 400 either', async () => {
    const { f, attempts } = countingFetch('{"error":{"message":"invalid api key"}}')
    await expect(discoverOwnedPods(f, 'http://rpc', '0xpm', WALLET, 0n, 30_000n)).rejects.toThrow(/invalid api key/)
    expect(attempts).toHaveLength(1)
  })

  it('STILL shrinks on a real range-cap 400 (the fix must not disable the adaptation)', async () => {
    // Guard against over-narrowing: the behaviour the previous fix added has to survive.
    const { f, attempts } = countingFetch('{"error":{"message":"block range too large"}}')
    await expect(discoverOwnedPods(f, 'http://rpc', '0xpm', WALLET, 0n, 30_000n)).rejects.toThrow(/HTTP 400/)
    expect(attempts.length).toBeGreaterThan(1) // shrank 9000 → … → 500 before giving up
    expect(attempts[attempts.length - 1]).toBeLessThan(attempts[0])
  })

  it('keeps the benefit of the doubt on a bare 400 with no usable body', async () => {
    // Unknown 400 → assume range cap, because halving is cheap and a cap is the common case.
    const { f, attempts } = countingFetch('')
    await expect(discoverOwnedPods(f, 'http://rpc', '0xpm', WALLET, 0n, 30_000n)).rejects.toThrow(/HTTP 400/)
    expect(attempts.length).toBeGreaterThan(1)
  })
})
