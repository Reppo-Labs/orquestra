import { describe, expect, it, vi } from 'vitest'
import { GatewayClient, GatewayError } from './client.js'

const opts = { baseUrl: 'https://gw', agentId: 'a', apiKey: 'k' }

const goodLease = {
  jobId: 'j1',
  request: { type: 'answer', payload: 'p', criteria: ['c'] },
  epoch: 128,
  answerCutoff: '2026-08-27T01:00:00.000Z',
}

// Datanet ids are subnet cuids on the wire (evalworker/datanetClient.ts).
const DN_A = 'cms3uejpj0001jf040zjgwqwm'
const DN_B = 'cmnhuowns000bic04e16t6735'

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

  it('lease rejects the retired corpus fields as version skew (strict schema)', async () => {
    const stale = { ...goodLease, datanetId: 1, corpusUrl: 'https://bucket/corpus.json', corpusVersion: '20260826T110000Z' }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(stale), { status: 200 }))
    const c = new GatewayClient({ ...opts, fetchImpl })
    const err = await c.lease().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).message).toMatch(/shape mismatch \(gateway\/worker version skew\?\)/)
  })

  it('deny posts { jobId, reason, datanetsSearched } to :deny', async () => {
    let sent: unknown
    let url = ''
    const fetchImpl = vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
      url = String(u)
      sent = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    })
    const c = new GatewayClient({ ...opts, fetchImpl })
    await c.deny('j1', 'nothing bears on: c2', [DN_A, DN_B])
    expect(url).toBe('https://gw/v1/node/jobs/j1:deny')
    expect(sent).toEqual({ jobId: 'j1', reason: 'nothing bears on: c2', datanetsSearched: [DN_A, DN_B] })
  })

  it('deny surfaces the gateway status and body (409 ALREADY_ANSWERED is terminal for the worker)', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"code":"ALREADY_ANSWERED"}', { status: 409 }))
    const c = new GatewayClient({ ...opts, fetchImpl })
    const err = await c.deny('j1', 'r', [DN_A]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).status).toBe(409)
    expect((err as GatewayError).message).toContain('ALREADY_ANSWERED')
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
    await c.deny('j', 'r', [DN_A]).catch(() => {})
    expect(signals).toHaveLength(3)
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal)
  })
})
