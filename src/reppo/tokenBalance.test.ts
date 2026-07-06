// src/reppo/tokenBalance.test.ts
import { describe, it, expect } from 'vitest'
import { readTokenBalance } from './tokenBalance.js'

const TOKEN = '0xExy0000000000000000000000000000000000001'
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const BALANCE_OF_SELECTOR = '0x70a08231'

// A fake JSON-RPC endpoint that returns `result` for eth_call. Captures the request
// body so the test can assert the encoded balanceOf(owner) calldata + target token.
const fakeRpc = (result: unknown, captured: { body?: any } = {}) =>
  (async (_url: string, init: { body: string }) => {
    captured.body = JSON.parse(init.body)
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
  }) as unknown as typeof fetch

describe('readTokenBalance', () => {
  it('returns the raw token balance from eth_call balanceOf', async () => {
    // 50 EXY at 6 decimals = 50_000_000 raw = 0x2faf080
    const raw = 50_000_000n
    const word = '0x' + raw.toString(16).padStart(64, '0')
    const bal = await readTokenBalance('https://rpc', TOKEN, OWNER, { fetchImpl: fakeRpc(word) })
    expect(bal).toBe(raw)
  })

  it('encodes balanceOf(owner) calldata against the token address', async () => {
    const captured: { body?: any } = {}
    await readTokenBalance('https://rpc', TOKEN, OWNER, { fetchImpl: fakeRpc('0x' + '0'.repeat(64), captured) })
    expect(captured.body.method).toBe('eth_call')
    const [call, block] = captured.body.params
    expect(block).toBe('latest')
    expect(call.to).toBe(TOKEN)
    // selector + 32-byte left-padded owner address (lowercased, no 0x)
    expect(call.data).toBe(BALANCE_OF_SELECTOR + OWNER.toLowerCase().replace(/^0x/, '').padStart(64, '0'))
  })

  it('returns 0n when the wallet holds none of the token', async () => {
    const bal = await readTokenBalance('https://rpc', TOKEN, OWNER, { fetchImpl: fakeRpc('0x' + '0'.repeat(64)) })
    expect(bal).toBe(0n)
  })

  it('throws on an empty eth_call result (bad token address ≠ zero balance)', async () => {
    await expect(readTokenBalance('https://rpc', TOKEN, OWNER, { fetchImpl: fakeRpc('0x') }))
      .rejects.toThrow(/returned no data/)
  })

  it('propagates a transport/RPC failure (does not swallow it as 0)', async () => {
    const throwing = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    await expect(readTokenBalance('https://rpc', TOKEN, OWNER, { fetchImpl: throwing }))
      .rejects.toThrow(/ECONNREFUSED/)
  })
})
