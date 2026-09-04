import { describe, expect, it, vi } from 'vitest'
import { makeDatanetClient } from './datanetClient.js'
import { DatanetError } from './datanet.js'

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
    expect(await c.fetchPods(DN_A, 200)).toEqual([
      { datanetId: DN_A, podId: 'cmth6huiz0000l704x8lt4te2', name: 'backtest', text: 'expectancy' },
      { datanetId: DN_A, podId: 'cmsmcxx8u0000jr04cbdl20p4', name: 'wicks', text: 'stop hunts' },
    ])
    expect(calls[0]?.url).toBe(`https://reppo.ai/api/v1/public/pods?filters[subnet]=${DN_A}`)
  })

  it("tags a pod with its OWN row's privateSubnetId, never the requested id or its tokenId", async () => {
    const { fetchImpl } = capture(() => json({ data: { pods: [podRow({ privateSubnetId: DN_B, tokenId: '77' })] } }))
    const c = makeDatanetClient({ baseUrl: 'https://b', fetchImpl })
    expect((await c.fetchPods(DN_A, 5))[0]?.datanetId).toBe(DN_B)
  })

  it('applies the limit CLIENT-side, because the server ignores it', async () => {
    const { calls, fetchImpl } = capture(() => json({ data: { pods: [podRow({ id: 'a' }), podRow({ id: 'b' }), podRow({ id: 'c' })] } }))
    const c = makeDatanetClient({ baseUrl: 'https://b', fetchImpl })
    expect((await c.fetchPods(DN_A, 2)).map((p) => p.podId)).toEqual(['a', 'b'])
    // No `limit` (nor `page`, nor `filters[currentEpoch]`) is sent: the server
    // ignores the first two and the third does not filter by its argument.
    expect(calls[0]?.url).not.toMatch(/limit|page|currentEpoch/)
  })

  it('reads the envelope STRICTLY — a bare array or a differently-keyed body is drift, not an empty datanet', async () => {
    const bare = capture(() => json([{ id: DN_A, subnetName: 'perps' }]))
    await expect(makeDatanetClient({ baseUrl: 'https://b', fetchImpl: bare.fetchImpl }).listAccessible()).rejects.toThrow(/public\/subnets/)
    // `data` holding the array directly is the exact mistake that passed the
    // gateway's mocked suite — it must NOT parse here.
    const flat = capture(() => json({ data: [podRow()] }))
    await expect(makeDatanetClient({ baseUrl: 'https://b', fetchImpl: flat.fetchImpl }).fetchPods(DN_A, 1)).rejects.toThrow(/public\/pods/)
    const wrapped = capture(() => json({ pods: [podRow()] }))
    await expect(makeDatanetClient({ baseUrl: 'https://b', fetchImpl: wrapped.fetchImpl }).fetchPods(DN_A, 1)).rejects.toThrow(/public\/pods/)
  })

  it('throws when a pod row is missing privateSubnetId (we cannot say which datanet it belongs to)', async () => {
    const { fetchImpl } = capture(() => json({ data: { pods: [{ id: 'p', name: 'n', description: 'd' }] } }))
    await expect(makeDatanetClient({ baseUrl: 'https://b', fetchImpl }).fetchPods(DN_A, 1)).rejects.toThrow(/public\/pods/)
  })

  it('throws on any non-2xx (a failure is never "no evidence")', async () => {
    const { fetchImpl } = capture(() => new Response('forbidden', { status: 403 }))
    const c = makeDatanetClient({ baseUrl: 'https://b', fetchImpl })
    await expect(c.listAccessible()).rejects.toThrow(/HTTP 403/)
    await expect(c.fetchPods(DN_A, 1)).rejects.toThrow(/HTTP 403/)
  })

  it('throws a typed DatanetError carrying the status (401/403 keep the credential backoff wired)', async () => {
    const { fetchImpl } = capture(() => new Response('bad key', { status: 401 }))
    const c = makeDatanetClient({ baseUrl: 'https://b', fetchImpl })
    await expect(c.listAccessible()).rejects.toBeInstanceOf(DatanetError)
    await expect(c.listAccessible()).rejects.toMatchObject({ status: 401 })
    await expect(c.fetchPods(DN_A, 1)).rejects.toMatchObject({ status: 401 })
  })

  it('propagates network errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const c = makeDatanetClient({ baseUrl: 'https://b', fetchImpl })
    await expect(c.fetchPods(DN_A, 1)).rejects.toThrow('ECONNRESET')
  })
})
