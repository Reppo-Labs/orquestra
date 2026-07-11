// src/reppo/queryLockConstraints.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { queryLockConstraints } from './queryLockConstraints.js'
import { VE_REPPO_MAINNET } from './emissionsOnchain.js'

// Selectors the module reads (must match queryLockConstraints.ts). A wrong selector here
// would read a DIFFERENT contract method and silently produce garbage lock guidance.
const SEL_MAX_LOCK = '0x76f70003'
const SEL_EPOCH_LEN = '0x57d775f8'
const DAY = 86_400

// A uint256 return word (32 bytes, big-endian) for `n`.
const word = (n: bigint | number): string => '0x' + BigInt(n).toString(16).padStart(64, '0')

interface Captured { calls: Array<{ to: string; data: string }> }

/** Stub globalThis.fetch as a JSON-RPC endpoint that answers eth_call per selector and
 *  records the (to, data) of each request so the test can assert the exact calldata. */
function stubRpc(bySelector: Record<string, string>): Captured {
  const captured: Captured = { calls: [] }
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { method: string; params: [{ to: string; data: string }, string] }
    const call = body.params[0]
    captured.calls.push({ to: call.to, data: call.data })
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: bySelector[call.data] ?? '0x' }) }
  }) as unknown as typeof fetch
  return captured
}

const origFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = origFetch })

describe('queryLockConstraints', () => {
  it('decodes and scales seconds → days (uses the 86400 divisor, not hours/weeks)', async () => {
    stubRpc({
      [SEL_MAX_LOCK]: word(730 * DAY), // ~2 years
      [SEL_EPOCH_LEN]: word(7 * DAY),  // 1-week epoch
    })
    const r = await queryLockConstraints('https://rpc')
    // If the divisor were wrong (e.g. 3600) maxLockDays would be 24× too large.
    expect(r).toEqual({ maxLockDays: 730, epochDays: 7 })
  })

  it('sends the discovered selectors to the veREPPO proxy address (catches a wrong selector/target)', async () => {
    const cap = stubRpc({ [SEL_MAX_LOCK]: word(365 * DAY), [SEL_EPOCH_LEN]: word(7 * DAY) })
    await queryLockConstraints('https://rpc')
    expect(cap.calls).toHaveLength(2)
    for (const c of cap.calls) expect(c.to).toBe(VE_REPPO_MAINNET)
    const selectors = cap.calls.map((c) => c.data).sort()
    expect(selectors).toEqual([SEL_MAX_LOCK, SEL_EPOCH_LEN].sort())
  })

  it('rounds a fractional day to the nearest whole day', async () => {
    stubRpc({
      [SEL_MAX_LOCK]: word(365 * DAY + Math.round(0.75 * DAY)), // 365.75 → 366
      [SEL_EPOCH_LEN]: word(7 * DAY + Math.round(0.25 * DAY)),  // 7.25 → 7
    })
    const r = await queryLockConstraints('https://rpc')
    expect(r.maxLockDays).toBe(366)
    expect(r.epochDays).toBe(7)
  })

  it('treats an empty eth_call result (0x) as 0 rather than throwing', async () => {
    stubRpc({}) // both selectors fall through to '0x'
    const r = await queryLockConstraints('https://rpc')
    expect(r).toEqual({ maxLockDays: 0, epochDays: 0 })
  })
})
