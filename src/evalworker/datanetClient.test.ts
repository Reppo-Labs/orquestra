import { afterEach, describe, expect, it, vi } from 'vitest'
import { datanetApiBase, makeDatanetClient, PODS_PAGE_SIZE } from './datanetClient.js'
import { DatanetError } from './datanet.js'
import { gatherEvidence } from './retrieve.js'

// Envelopes and field names below mirror the live API probed 2026-09-04; the
// non-hermetic guard that they still hold is datanetClient.live.test.ts.
const DN_A = 'cms3uejpj0001jf040zjgwqwm'
const DN_B = 'cmnhuowns000bic04e16t6735'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const capture = (respond: (url: string) => Response) => {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return respond(String(url))
  })
  return { calls, fetchImpl }
}

const podRow = (over: Record<string, unknown> = {}) => ({
  id: 'cmth6huiz0000l704x8lt4te2',
  name: 'backtest',
  description: 'expectancy',
  url: 'https://example.test/p',
  privateSubnetId: DN_A,
  tokenId: '9',
  chainId: 8453,
  ...over,
})

/** Serves `rows` the way the live API does since 2026-09-10: `limit` rows from
 *  the 1-indexed `page` in the URL. */
const pageOf = (rows: unknown[], url: string) => {
  const limit = Number(new URL(url).searchParams.get('limit') ?? rows.length)
  const page = Number(new URL(url).searchParams.get('page') ?? 1)
  return rows.slice((page - 1) * limit, page * limit)
}

describe('makeDatanetClient', () => {
  it('lists datanets from GET {base}/public/subnets, mapping id/subnetName — and sends NO credential', async () => {
    const { calls, fetchImpl } = capture(() =>
      json({ data: { subnets: [{ id: DN_A, subnetName: 'perps', tokenId: '2', chainId: 8453 }, { id: DN_B, subnetName: 'sql', tokenId: '2', chainId: 4663 }] } }),
    )
    const c = makeDatanetClient({ baseUrl: 'https://reppo.ai/api/v1/', fetchImpl })
    expect(await c.listAccessible()).toEqual([
      { datanetId: DN_A, name: 'perps' },
      { datanetId: DN_B, name: 'sql' },
    ])
    expect(calls[0]?.url).toBe('https://reppo.ai/api/v1/public/subnets')
    // The endpoint is public: an Authorization header would be a new, unprobed
    // request shape. Both rows above carry tokenId "2" on different chains —
    // the collision that disqualified the numeric id.
    expect(calls[0]?.init?.headers).toEqual({ accept: 'application/json' })
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('fetches pods from GET {base}/public/pods?filters[subnet]=<cuid>, reading text from `description`', async () => {
    const { calls, fetchImpl } = capture(() =>
      json({ data: { pods: [podRow(), podRow({ id: 'cmsmcxx8u0000jr04cbdl20p4', name: 'wicks', description: 'stop hunts' })] } }),
    )
    const c = makeDatanetClient({ baseUrl: 'https://reppo.ai/api/v1', fetchImpl })
    expect(await c.fetchPods(DN_A)).toEqual([
      { datanetId: DN_A, podId: 'cmth6huiz0000l704x8lt4te2', name: 'backtest', text: 'expectancy' },
      { datanetId: DN_A, podId: 'cmsmcxx8u0000jr04cbdl20p4', name: 'wicks', text: 'stop hunts' },
    ])
    expect(calls[0]?.url).toBe(`https://reppo.ai/api/v1/public/pods?filters[subnet]=${DN_A}&limit=${PODS_PAGE_SIZE}&page=1`)
  })

  it("tags a pod with its OWN row's privateSubnetId, never the requested id or its tokenId", async () => {
    const { fetchImpl } = capture(() => json({ data: { pods: [podRow({ privateSubnetId: DN_B, tokenId: '77' })] } }))
    const c = makeDatanetClient({ baseUrl: 'https://b', fetchImpl })
    expect((await c.fetchPods(DN_A))[0]?.datanetId).toBe(DN_B)
  })

  it('never truncates before ranking: a matching pod at row 1500 of a 1719-row subnet reaches the candidates', async () => {
    // The server orders rows createdAt-ish, not by relevance, so any prefix
    // hides evidence. 1719 rows is ArAIstotle; served here as 18 pages.
    const rows = Array.from({ length: 1719 }, (_, i) =>
      podRow({ id: `row${i}`, name: i === 1500 ? 'liquidation cascade wick' : 'unrelated', description: i === 1500 ? 'stop hunt liquidation cascade' : 'lorem ipsum' }),
    )
    const { calls, fetchImpl } = capture((url) =>
      url.endsWith('/public/subnets') ? json({ data: { subnets: [{ id: DN_A, subnetName: 'araistotle' }] } }) : json({ data: { pods: pageOf(rows, url) } }),
    )
    const c = makeDatanetClient({ baseUrl: 'https://b', fetchImpl })
    expect(await c.fetchPods(DN_A)).toHaveLength(1719)
    const out = await gatherEvidence(c, { type: 'answer', payload: 'liquidation cascade after a stop hunt wick', criteria: ['is grounded'] })
    expect(out.candidates.map((r) => r.pod.podId)).toContain('row1500')
    // Every page is requested explicitly; the unparameterised read this file
    // used to make now returns only the server's first 20 rows (#222).
    expect(calls[0]?.url).toContain(`limit=${PODS_PAGE_SIZE}&page=1`)
    expect(calls.some((c2) => c2.url.includes('page=18'))).toBe(true)
    expect(calls[0]?.url).not.toMatch(/currentEpoch/)
  })

  it('pages to exhaustion — a 383-row subnet yields 383 pods, not the server default page', async () => {
    // The live shape that exposed #222: an unparameterised read of TradingGym
    // returned 20 of 383 rows (5.2%), and nothing in the type could tell.
    const rows = Array.from({ length: 383 }, (_, i) => podRow({ id: `p${i}` }))
    const { calls, fetchImpl } = capture((url) => json({ data: { pods: pageOf(rows, url) } }))
    const pods = await makeDatanetClient({ baseUrl: 'https://b', fetchImpl }).fetchPods(DN_A)
    expect(pods).toHaveLength(383)
    expect(new Set(pods.map((p) => p.podId)).size).toBe(383)
    // 4 pages: 100 + 100 + 100 + 83 (the short page ends the loop).
    expect(calls).toHaveLength(4)
  })

  it('stops on a short page without requesting another', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => podRow({ id: `p${i}` }))
    const { calls, fetchImpl } = capture((url) => json({ data: { pods: pageOf(rows, url) } }))
    expect(await makeDatanetClient({ baseUrl: 'https://b', fetchImpl }).fetchPods(DN_A)).toHaveLength(7)
    expect(calls).toHaveLength(1)
  })

  it('THROWS when `page` is ignored — a repeated full page is a truncated read, never a short datanet', async () => {
    // The dangerous regression: `limit` honoured, `page` not. Every request
    // returns the same 100 rows, so the rest is unreachable. Returning those
    // 100 would reach the ranker looking complete and could become a denial.
    const rows = Array.from({ length: 100 }, (_, i) => podRow({ id: `p${i}` }))
    const { fetchImpl } = capture(() => json({ data: { pods: rows } }))
    await expect(makeDatanetClient({ baseUrl: 'https://b', fetchImpl }).fetchPods(DN_A)).rejects.toThrow(/pagination is not being honoured/)
  })

  it('treats an over-sized page as the pre-pagination server and returns it whole', async () => {
    // Forward/backward compatible: if the server reverts to ignoring `limit`,
    // one response is the entire subnet. That is complete, not truncated.
    const rows = Array.from({ length: 3343 }, (_, i) => podRow({ id: `p${i}` }))
    const { calls, fetchImpl } = capture(() => json({ data: { pods: rows } }))
    expect(await makeDatanetClient({ baseUrl: 'https://b', fetchImpl }).fetchPods(DN_A)).toHaveLength(3343)
    expect(calls).toHaveLength(1)
  })

  it('reads the envelope STRICTLY — a bare array or a differently-keyed body is drift, not an empty datanet', async () => {
    const bare = capture(() => json([{ id: DN_A, subnetName: 'perps' }]))
    await expect(makeDatanetClient({ baseUrl: 'https://b', fetchImpl: bare.fetchImpl }).listAccessible()).rejects.toThrow(/public\/subnets/)
    // `data` holding the array directly is the exact mistake that passed the
    // gateway's mocked suite — it must NOT parse here.
    const flat = capture(() => json({ data: [podRow()] }))
    await expect(makeDatanetClient({ baseUrl: 'https://b', fetchImpl: flat.fetchImpl }).fetchPods(DN_A)).rejects.toThrow(/public\/pods/)
    const wrapped = capture(() => json({ pods: [podRow()] }))
    await expect(makeDatanetClient({ baseUrl: 'https://b', fetchImpl: wrapped.fetchImpl }).fetchPods(DN_A)).rejects.toThrow(/public\/pods/)
  })

  it('a null name/description on ONE row reads as empty text — it must not make the whole subnet unreadable', async () => {
    // zod's .default() covers undefined only; a single null row used to throw
    // for the entire subnet, and every job then :fail-ed forever on it.
    const { fetchImpl } = capture(() =>
      json({ data: { pods: [podRow({ id: 'a' }), podRow({ id: 'b', description: null }), podRow({ id: 'c', name: null })] } }),
    )
    const pods = await makeDatanetClient({ baseUrl: 'https://b', fetchImpl }).fetchPods(DN_A)
    expect(pods.map((p) => p.podId)).toEqual(['a', 'b', 'c'])
    expect(pods[1]).toMatchObject({ name: 'backtest', text: '' })
    expect(pods[2]).toMatchObject({ name: '', text: 'expectancy' })
  })

  it('throws when a pod row is missing privateSubnetId (we cannot say which datanet it belongs to)', async () => {
    const { fetchImpl } = capture(() => json({ data: { pods: [{ id: 'p', name: 'n', description: 'd' }] } }))
    await expect(makeDatanetClient({ baseUrl: 'https://b', fetchImpl }).fetchPods(DN_A)).rejects.toThrow(/public\/pods/)
  })

  it('throws on any non-2xx (a failure is never "no evidence")', async () => {
    const { fetchImpl } = capture(() => new Response('forbidden', { status: 403 }))
    const c = makeDatanetClient({ baseUrl: 'https://b', fetchImpl })
    await expect(c.listAccessible()).rejects.toThrow(/HTTP 403/)
    await expect(c.fetchPods(DN_A)).rejects.toThrow(/HTTP 403/)
  })

  it('throws a typed DatanetError carrying the status (401/403 keep the proxy/WAF backoff wired)', async () => {
    const { fetchImpl } = capture(() => new Response('bad key', { status: 401 }))
    const c = makeDatanetClient({ baseUrl: 'https://b', fetchImpl })
    await expect(c.listAccessible()).rejects.toBeInstanceOf(DatanetError)
    await expect(c.listAccessible()).rejects.toMatchObject({ status: 401 })
    await expect(c.fetchPods(DN_A)).rejects.toMatchObject({ status: 401 })
  })

  it('propagates network errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const c = makeDatanetClient({ baseUrl: 'https://b', fetchImpl })
    await expect(c.fetchPods(DN_A)).rejects.toThrow('ECONNRESET')
  })
})

describe('datanetApiBase', () => {
  const saved = { net: process.env.REPPO_NETWORK, url: process.env.EVAL_DATANET_API_URL }
  afterEach(() => {
    if (saved.net === undefined) delete process.env.REPPO_NETWORK
    else process.env.REPPO_NETWORK = saved.net
    if (saved.url === undefined) delete process.env.EVAL_DATANET_API_URL
    else process.env.EVAL_DATANET_API_URL = saved.url
  })

  it('is reppo.ai on a robinhood-network node too — the catalog the gateway verifies citations against, not platformBase()', () => {
    process.env.REPPO_NETWORK = 'robinhood'
    delete process.env.EVAL_DATANET_API_URL
    // robinhood.reppo.ai lists a subnet (Genesis Playground) whose pods 404 on
    // reppo.ai, where eval-api resolves citations: citing it earns an
    // UNRESOLVABLE_CITATION discard against this node.
    expect(datanetApiBase()).toBe('https://reppo.ai/api/v1')
  })

  it('honours the EVAL_DATANET_API_URL override, trimmed', () => {
    process.env.REPPO_NETWORK = 'robinhood'
    process.env.EVAL_DATANET_API_URL = ' https://staging.example/api/v1 '
    expect(datanetApiBase()).toBe('https://staging.example/api/v1')
  })
})
