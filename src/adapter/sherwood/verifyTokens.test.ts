import { describe, expect, it } from 'vitest'
import { decodeNameReturn, fetchOnchainName, verifyRwaFlagsOnchain } from './verifyTokens.js'
import type { PoolInfo, TokenRef } from './pools.js'

/** ABI-encode a string return the way eth_call serves it. */
function abiString(s: string): string {
  const bytes = Buffer.from(s, 'utf8')
  const len = bytes.length.toString(16).padStart(64, '0')
  const data = bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0')
  return '0x' + '20'.padStart(64, '0') + len + data
}

/** Fetch stub serving a canned JSON-RPC result per lowercased `to` address. */
function rpcStub(names: Record<string, string | undefined>): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const req = JSON.parse(String(init?.body))
    const to = String(req.params[0].to).toLowerCase()
    const name = names[to]
    const result = name === undefined ? '0x' : abiString(name)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  }) as typeof fetch
}

const token = (address: string, isTokenizedStock: boolean, symbol = 'T'): TokenRef => ({
  symbol,
  name: `${symbol} name from the API`,
  address,
  isTokenizedStock,
})

const pool = (base?: TokenRef, quote?: TokenRef): PoolInfo => ({
  name: 'p / q 0.05%',
  address: '0xpool' + (base?.address ?? '') + (quote?.address ?? ''),
  dex: 'uniswap-v3-robinhood',
  reserveUsd: 100_000,
  volumeUsd24h: 1_000,
  ...(base ? { base } : {}),
  ...(quote ? { quote } : {}),
})

describe('decodeNameReturn', () => {
  it('decodes a standard ABI string', () => {
    expect(decodeNameReturn(abiString('NVIDIA • Robinhood Token'))).toBe('NVIDIA • Robinhood Token')
  })
  it('decodes a legacy bytes32 name', () => {
    const hex = '0x' + Buffer.from('MKR', 'utf8').toString('hex').padEnd(64, '0')
    expect(decodeNameReturn(hex)).toBe('MKR')
  })
  it('returns undefined for empty or malformed data', () => {
    expect(decodeNameReturn('0x')).toBeUndefined()
    expect(decodeNameReturn('0xdead')).toBeUndefined()
  })
})

describe('fetchOnchainName', () => {
  it('reads name() via eth_call', async () => {
    const f = rpcStub({ '0xaaa': 'GameStop • Robinhood Token' })
    expect(await fetchOnchainName('http://rpc', '0xAAA', f)).toBe('GameStop • Robinhood Token')
  })
  it('resolves undefined on empty returndata (no such function)', async () => {
    const f = rpcStub({})
    expect(await fetchOnchainName('http://rpc', '0xaaa', f)).toBeUndefined()
  })
})

describe('verifyRwaFlagsOnchain', () => {
  it('keeps the flag when the chain confirms the marker', async () => {
    const p = pool(token('0xnvda', true, 'nvda'))
    const out = await verifyRwaFlagsOnchain([p], 'http://rpc', {
      fetchImpl: rpcStub({ '0xnvda': 'NVIDIA • Robinhood Token' }),
      log: () => {},
    })
    expect(out[0].base?.isTokenizedStock).toBe(true)
  })

  it('clears the flag when on-chain name() lacks the marker (memecoin impersonation)', async () => {
    const p = pool(token('0xfake', true, 'STONK'))
    const logs: string[] = []
    const out = await verifyRwaFlagsOnchain([p], 'http://rpc', {
      fetchImpl: rpcStub({ '0xfake': 'Totally A Stock' }),
      log: (s) => logs.push(s),
    })
    expect(out[0].base?.isTokenizedStock).toBe(false)
    expect(logs.join('\n')).toContain('0xfake')
  })

  it('clears the flag when name() returns no data', async () => {
    const p = pool(token('0xeoa', true))
    const out = await verifyRwaFlagsOnchain([p], 'http://rpc', {
      fetchImpl: rpcStub({}),
      log: () => {},
    })
    expect(out[0].base?.isTokenizedStock).toBe(false)
  })

  it('fails closed this cycle on RPC transport failure, without caching the verdict', async () => {
    const cache = new Map<string, boolean>()
    const failing = (async () => new Response('boom', { status: 503 })) as typeof fetch
    const p = pool(token('0xnvda', true, 'nvda'))
    const out = await verifyRwaFlagsOnchain([p], 'http://rpc', { fetchImpl: failing, cache, log: () => {} })
    expect(out[0].base?.isTokenizedStock).toBe(false)
    expect(cache.size).toBe(0) // retried next cycle
  })

  it('serves repeat tokens from the cache without another call', async () => {
    const cache = new Map<string, boolean>()
    let calls = 0
    const counting = (async (url: unknown, init?: { body?: unknown }) => {
      calls++
      return rpcStub({ '0xnvda': 'NVIDIA • Robinhood Token' })(url as string, init as RequestInit)
    }) as typeof fetch
    const p = pool(token('0xnvda', true, 'nvda'), token('0xNVDA', true, 'nvda'))
    await verifyRwaFlagsOnchain([p], 'http://rpc', { fetchImpl: counting, cache, log: () => {} })
    await verifyRwaFlagsOnchain([p], 'http://rpc', { fetchImpl: counting, cache, log: () => {} })
    expect(calls).toBe(1) // dedup by lowercased address + cross-cycle cache
  })

  it('leaves unflagged tokens and their pools untouched', async () => {
    const p = pool(token('0xmeme', false, 'MEME'))
    let calls = 0
    const counting = (async () => {
      calls++
      return new Response('{}')
    }) as typeof fetch
    const out = await verifyRwaFlagsOnchain([p], 'http://rpc', { fetchImpl: counting, log: () => {} })
    expect(calls).toBe(0)
    expect(out[0]).toBe(p) // same object — no needless copies
  })
})
