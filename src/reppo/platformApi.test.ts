import { describe, it, expect, vi } from 'vitest'
import { registerVoteOnPlatform, updateAgentOnPlatform } from './platformApi.js'

const fakeResp = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

const makeFetch = (status: number, body: unknown) =>
  vi.fn(async () => fakeResp(status, body)) as unknown as typeof fetch

describe('registerVoteOnPlatform', () => {
  it('returns platform vote id on 200 with data.id', async () => {
    const fetchImpl = vi.fn(makeFetch(200, { data: { id: 'reg-1' } }))
    const result = await registerVoteOnPlatform('agent-1', 'pod-abc', '0xtx', 'key-xyz', fetchImpl)
    expect(result).toBe('reg-1')
    const [url, opts] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/agents/agent-1/pods/pod-abc/votes')
    expect(JSON.parse(opts.body as string)).toEqual({ txHash: '0xtx' })
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer key-xyz')
  })

  it('returns empty string when data.id is missing', async () => {
    const result = await registerVoteOnPlatform('a', 'p', '0x1', 'k', makeFetch(200, {}))
    expect(result).toBe('')
  })

  it('URL-encodes agentId and podId', async () => {
    const fetchImpl = vi.fn(makeFetch(200, { data: { id: 'r' } }))
    await registerVoteOnPlatform('agent/1', 'pod 2', '0x', 'k', fetchImpl)
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toContain('agent%2F1')
    expect(url).toContain('pod%202')
  })

  it('throws on non-2xx response with status and truncated body', async () => {
    await expect(
      registerVoteOnPlatform('a', 'p', '0x', 'k', makeFetch(401, { error: 'unauthorized' })),
    ).rejects.toThrow('platform registerVote 401')
  })

  it('retries once on 5xx then throws if still failing', async () => {
    const fetchImpl = vi.fn(makeFetch(503, { error: 'unavailable' }))
    await expect(
      registerVoteOnPlatform('a', 'p', '0x', 'k', fetchImpl, 0),
    ).rejects.toThrow('platform registerVote 503')
    expect(fetchImpl).toHaveBeenCalledTimes(2) // initial + one retry
  })

  it('retries once on 429 then throws if still failing', async () => {
    const fetchImpl = vi.fn(makeFetch(429, { error: 'rate limited' }))
    await expect(
      registerVoteOnPlatform('a', 'p', '0x', 'k', fetchImpl, 0),
    ).rejects.toThrow('platform registerVote 429')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('succeeds on second attempt after a 5xx first attempt', async () => {
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call++
      return call === 1 ? fakeResp(500, {}) : fakeResp(200, { data: { id: 'ok-on-retry' } })
    }) as unknown as typeof fetch
    const result = await registerVoteOnPlatform('a', 'p', '0x', 'k', fetchImpl, 0)
    expect(result).toBe('ok-on-retry')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('propagates a network-level fetch rejection', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    await expect(
      registerVoteOnPlatform('a', 'p', '0x', 'k', fetchImpl),
    ).rejects.toThrow('ECONNREFUSED')
  })

  it('wires AbortController signal into each fetch call', async () => {
    let capturedSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (_url: string, opts: RequestInit) => {
      capturedSignal = opts.signal as AbortSignal
      return fakeResp(200, { data: { id: 'r' } })
    }) as unknown as typeof fetch
    await registerVoteOnPlatform('a', 'p', '0x', 'k', fetchImpl)
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal).toBeInstanceOf(AbortSignal)
  })
})

describe('updateAgentOnPlatform', () => {
  it('PATCHes /agents/:id with Bearer auth and the patch body', async () => {
    const fetchImpl = vi.fn(makeFetch(200, { data: { id: 'ag_1' } }))
    await updateAgentOnPlatform('ag_1', { name: 'my-node' }, 'key-xyz', fetchImpl)
    const [url, opts] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/agents\/ag_1$/)
    expect(opts.method).toBe('PATCH')
    expect(JSON.parse(opts.body as string)).toEqual({ name: 'my-node' })
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer key-xyz')
  })

  it('URL-encodes the agent id', async () => {
    const fetchImpl = vi.fn(makeFetch(200, {}))
    await updateAgentOnPlatform('agent/1', { name: 'n' }, 'k', fetchImpl)
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toContain('agent%2F1')
  })

  it('throws on non-2xx with status and truncated body', async () => {
    await expect(
      updateAgentOnPlatform('ag_1', { name: 'n' }, 'bad-key', makeFetch(401, { error: 'unauthorized' })),
    ).rejects.toThrow('platform updateAgent 401')
  })
})
