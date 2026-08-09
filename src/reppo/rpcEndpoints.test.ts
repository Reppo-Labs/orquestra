// src/reppo/rpcEndpoints.test.ts
import { describe, it, expect, vi } from 'vitest'
import { parseRpcEndpoints, primaryRpcEndpoint, rpcFetch, AllRpcEndpointsFailedError } from './rpcEndpoints.js'

const ok = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), { status: 200 })
const status = (s: number) => new Response('nope', { status: s })
const INIT = { method: 'POST', body: '{}' }

describe('parseRpcEndpoints', () => {
  it('parses a single url unchanged', () => {
    expect(parseRpcEndpoints('https://a.example/rpc')).toEqual(['https://a.example/rpc'])
  })
  it('splits on commas, newlines and stray whitespace, and de-duplicates in order', () => {
    expect(parseRpcEndpoints(' https://a.example ,\n https://b.example ,https://a.example '))
      .toEqual(['https://a.example', 'https://b.example'])
  })
  it('treats unset / blank as no endpoints', () => {
    expect(parseRpcEndpoints(undefined)).toEqual([])
    expect(parseRpcEndpoints('   ')).toEqual([])
  })
})

describe('primaryRpcEndpoint', () => {
  it('returns the FIRST endpoint — the reppo CLI --rpc-url takes exactly one', () => {
    expect(primaryRpcEndpoint('https://a.example,https://b.example')).toBe('https://a.example')
  })
  it('returns empty string when nothing is configured', () => {
    expect(primaryRpcEndpoint('')).toBe('')
  })
})

describe('rpcFetch failover', () => {
  it('single endpoint: one call, error propagates verbatim (unchanged behaviour)', async () => {
    const f = vi.fn(async () => { throw new Error('boom') }) as unknown as typeof fetch
    await expect(rpcFetch(f, 'https://a.example', INIT)).rejects.toThrow('boom')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('falls over to the next endpoint when the first peer is DOWN (transport throw)', async () => {
    const seen: string[] = []
    const f = vi.fn(async (url: string) => {
      seen.push(url)
      if (url.includes('dead')) throw new Error('ECONNREFUSED')
      return ok()
    }) as unknown as typeof fetch
    const res = await rpcFetch(f, 'https://dead.example,https://live.example', INIT)
    expect(res.status).toBe(200)
    expect(seen).toEqual(['https://dead.example', 'https://live.example'])
  })

  it.each([500, 502, 503, 408, 429])('falls over on an unhealthy-peer status %i', async (code) => {
    const f = vi.fn(async (url: string) => (url.includes('sick') ? status(code) : ok())) as unknown as typeof fetch
    expect((await rpcFetch(f, 'https://sick.example,https://live.example', INIT)).status).toBe(200)
  })

  it('does NOT fail over on a 400 — that is a bad REQUEST (getLogs range cap), not a dead peer', async () => {
    // emissionsOnchain.ts answers a 400 by HALVING its getLogs chunk. Re-sending the same
    // oversized request to every fallback would burn quota and hide that signal.
    const f = vi.fn(async () => status(400)) as unknown as typeof fetch
    const res = await rpcFetch(f, 'https://a.example,https://b.example', INIT)
    expect(res.status).toBe(400)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('does NOT fail over on a JSON-RPC error body — a revert is a real answer from a healthy peer', async () => {
    // The claim-probe oracle in emissionsOnchain.ts reads a revert as "nothing due".
    const f = vi.fn(async () => new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }), { status: 200 },
    )) as unknown as typeof fetch
    const res = await rpcFetch(f, 'https://a.example,https://b.example', INIT)
    expect((await res.json() as { error: { message: string } }).error.message).toBe('execution reverted')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('CRITICAL: when EVERY endpoint fails it THROWS — it never fabricates a zero/empty answer', async () => {
    // Fail-open: an unread on-chain value must stay UNREAD. Callers turn a throw into
    // "unavailable this cycle" (yield omitted, pool unknown, legacy vote sizing) — never
    // into a dry pool or a silenced node.
    const f = vi.fn(async () => { throw new Error('ETIMEDOUT') }) as unknown as typeof fetch
    const err = await rpcFetch(f, 'https://a.example,https://b.example', INIT).catch((e) => e)
    expect(err).toBeInstanceOf(AllRpcEndpointsFailedError)
    expect(err.endpoints).toBe(2)
    expect(err.message).toMatch(/all 2 configured RPC endpoints failed/)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('the all-failed message names HOSTS only — never the path, which carries the provider key', async () => {
    const f = (async () => { throw new Error('down') }) as unknown as typeof fetch
    const err: Error = await rpcFetch(f, 'https://eth.example/v2/SUPERSECRETKEY,https://b.example/v2/OTHERKEY', INIT).catch((e) => e)
    expect(err.message).toContain('eth.example')
    expect(err.message).not.toContain('SUPERSECRETKEY')
    expect(err.message).not.toContain('OTHERKEY')
  })

  it('throws a configuration error (not a bare fetch failure) when no endpoint is set', async () => {
    const f = vi.fn() as unknown as typeof fetch
    await expect(rpcFetch(f, '', INIT)).rejects.toThrow(/no RPC endpoint configured/)
    expect(f).not.toHaveBeenCalled()
  })
})
