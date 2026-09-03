import { describe, expect, it, vi } from 'vitest'
import { makeDatanetClient } from './datanetClient.js'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const capture = (respond: (url: string) => Response) => {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return respond(String(url))
  })
  return { calls, fetchImpl }
}

describe('makeDatanetClient (provisional binding)', () => {
  it('lists accessible datanets from GET {base}/datanets with the node bearer key', async () => {
    const { calls, fetchImpl } = capture(() => json([{ id: 27, name: 'perps' }, { id: 31, name: 'sql' }]))
    const c = makeDatanetClient({ baseUrl: 'https://reppo.ai/api/v1/', apiKey: 'node-key', fetchImpl })
    expect(await c.listAccessible()).toEqual([
      { datanetId: 27, name: 'perps' },
      { datanetId: 31, name: 'sql' },
    ])
    expect(calls[0]?.url).toBe('https://reppo.ai/api/v1/datanets')
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer node-key' })
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('fetches pods from GET {base}/datanets/{id}/pods?limit=N and tags them with the datanet id', async () => {
    const { calls, fetchImpl } = capture(() => json({ pods: [{ id: 482, name: 'backtest', text: 'expectancy' }, { id: '517', name: 'wicks', text: 'stop hunts' }] }))
    const c = makeDatanetClient({ baseUrl: 'https://reppo.ai/api/v1', apiKey: 'k', fetchImpl })
    expect(await c.fetchPods(27, 200)).toEqual([
      { datanetId: 27, podId: '482', name: 'backtest', text: 'expectancy' },
      { datanetId: 27, podId: '517', name: 'wicks', text: 'stop hunts' },
    ])
    expect(calls[0]?.url).toBe('https://reppo.ai/api/v1/datanets/27/pods?limit=200')
  })

  it('accepts either a bare array or a wrapped list for both endpoints', async () => {
    const { fetchImpl } = capture((url) => (url.endsWith('/datanets') ? json({ datanets: [{ id: 5, name: 'n' }] }) : json([{ id: 'p1', name: 'x', text: 'y' }])))
    const c = makeDatanetClient({ baseUrl: 'https://b', apiKey: 'k', fetchImpl })
    expect(await c.listAccessible()).toEqual([{ datanetId: 5, name: 'n' }])
    expect(await c.fetchPods(5, 1)).toEqual([{ datanetId: 5, podId: 'p1', name: 'x', text: 'y' }])
  })

  it('throws on any non-2xx (a failure is never "no evidence")', async () => {
    const { fetchImpl } = capture(() => new Response('forbidden', { status: 403 }))
    const c = makeDatanetClient({ baseUrl: 'https://b', apiKey: 'k', fetchImpl })
    await expect(c.listAccessible()).rejects.toThrow(/HTTP 403/)
    await expect(c.fetchPods(1, 1)).rejects.toThrow(/HTTP 403/)
  })

  it('throws on a body that does not fit the assumed shape (binding drift, not an empty datanet)', async () => {
    const { fetchImpl } = capture(() => json({ unexpected: true }))
    const c = makeDatanetClient({ baseUrl: 'https://b', apiKey: 'k', fetchImpl })
    await expect(c.listAccessible()).rejects.toThrow(/shape/)
    await expect(c.fetchPods(1, 1)).rejects.toThrow(/shape/)
  })

  it('propagates network errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const c = makeDatanetClient({ baseUrl: 'https://b', apiKey: 'k', fetchImpl })
    await expect(c.fetchPods(1, 1)).rejects.toThrow('ECONNRESET')
  })
})
