import { describe, expect, it, vi } from 'vitest'
import { GatewayClient, GatewayError } from './client.js'

const opts = { baseUrl: 'https://gw', agentId: 'a', apiKey: 'k' }

const goodLease = {
  jobId: 'j1',
  request: { type: 'answer', payload: 'p', criteria: ['c'] },
  datanetId: 1,
  corpusUrl: 'https://bucket/corpus.json',
  leaseExpiresAt: '2026-08-26T12:04:00.000Z',
  settlementDeadline: '2026-08-26T12:05:00.000Z',
}

describe('GatewayClient', () => {
  it('lease returns null on 204 (the common empty long-poll)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const c = new GatewayClient({ ...opts, fetchImpl })
    expect(await c.lease()).toBeNull()
  })

  it('lease throws GatewayError carrying status AND the response body', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"agent not registered"}', { status: 401 }))
    const c = new GatewayClient({ ...opts, fetchImpl })
    const err = await c.lease().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).status).toBe(401)
    expect((err as GatewayError).message).toContain('agent not registered')
  })

  it('lease rejects a malformed 200 with a shape error, not a downstream TypeError', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jobId: 'j1' }), { status: 200 }))
    const c = new GatewayClient({ ...opts, fetchImpl })
    const err = await c.lease().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).message).toMatch(/shape mismatch/)
  })

  it('lease parses a valid response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(goodLease), { status: 200 }))
    const c = new GatewayClient({ ...opts, fetchImpl })
    const job = await c.lease()
    expect(job?.jobId).toBe('j1')
  })

  it('fetchCorpus rejects a corpus missing pods with a shape error', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ datanetId: 1, generatedAt: 'x' }), { status: 200 }))
    const c = new GatewayClient({ ...opts, fetchImpl })
    const err = await c.fetchCorpus('https://bucket/x.json').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).message).toMatch(/shape mismatch/)
  })

  it('every request carries an abort signal (hung-connection bound)', async () => {
    const signals: (AbortSignal | null | undefined)[] = []
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal)
      return new Response(null, { status: 204 })
    })
    const c = new GatewayClient({ ...opts, fetchImpl })
    await c.lease()
    await c.fail('j', 'r').catch(() => {})
    expect(signals).toHaveLength(2)
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal)
  })
})
