// src/reppo/exec.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { reppoEnv, withRpcUrl, isTransientReppoError, runReppoStdout } from './exec.js'

const saved = { ...process.env }
afterEach(() => {
  // restore env keys this suite touches
  for (const k of ['RPC_URL', 'REPPO_RPC_URL', 'REPPO_NETWORK']) delete process.env[k]
  Object.assign(process.env, { RPC_URL: saved.RPC_URL, REPPO_RPC_URL: saved.REPPO_RPC_URL, REPPO_NETWORK: saved.REPPO_NETWORK })
})

describe('reppoEnv', () => {
  it('defaults REPPO_NETWORK to mainnet when unset', () => {
    delete process.env.REPPO_NETWORK
    expect(reppoEnv().REPPO_NETWORK).toBe('mainnet')
  })
  it('preserves an explicit REPPO_NETWORK', () => {
    process.env.REPPO_NETWORK = 'testnet'
    expect(reppoEnv().REPPO_NETWORK).toBe('testnet')
  })
})

describe('withRpcUrl', () => {
  it('appends --rpc-url when RPC_URL is set', () => {
    delete process.env.REPPO_RPC_URL
    process.env.RPC_URL = 'https://base.example/rpc'
    expect(withRpcUrl(['query', 'datanet', '6', '--json'])).toEqual([
      'query', 'datanet', '6', '--json', '--rpc-url', 'https://base.example/rpc',
    ])
  })
  it('falls back to REPPO_RPC_URL when RPC_URL is unset', () => {
    delete process.env.RPC_URL
    process.env.REPPO_RPC_URL = 'https://alt.example/rpc'
    expect(withRpcUrl(['list', 'datanets'])).toEqual(['list', 'datanets', '--rpc-url', 'https://alt.example/rpc'])
  })
  it('leaves args unchanged when no RPC url env is set', () => {
    delete process.env.RPC_URL
    delete process.env.REPPO_RPC_URL
    expect(withRpcUrl(['query', 'balance', '--json'])).toEqual(['query', 'balance', '--json'])
  })
  it('treats a blank/whitespace RPC_URL as unset', () => {
    process.env.RPC_URL = '   '
    delete process.env.REPPO_RPC_URL
    expect(withRpcUrl(['vote'])).toEqual(['vote'])
  })
})

describe('isTransientReppoError', () => {
  it('matches the reppo.ai unreachable / fetch-failed blips', () => {
    expect(isTransientReppoError('Could not reach https://reppo.ai/...: fetch failed.')).toBe(true)
    expect(isTransientReppoError('{"error":{"code":"PUBLIC_API_UNREACHABLE"}}')).toBe(true)
    expect(isTransientReppoError('request to https://x failed, reason: ECONNRESET')).toBe(true)
    expect(isTransientReppoError('reppo command timed out')).toBe(true)
  })
  it('matches public-RPC rate-limit / INTERNAL_ERROR blips (operator hit these on mainnet.base.org)', () => {
    expect(isTransientReppoError('query datanet failed: INTERNAL_ERROR')).toBe(true)
    expect(isTransientReppoError('{"error":{"code":-32603,"message":"Internal error"}}')).toBe(true)
    expect(isTransientReppoError('HTTP 429 Too Many Requests')).toBe(true)
    expect(isTransientReppoError('rate limit exceeded')).toBe(true)
    expect(isTransientReppoError('rate-limited by upstream')).toBe(true)
  })
  it('does NOT match permanent errors', () => {
    expect(isTransientReppoError('CANNOT_VOTE_FOR_OWN_POD')).toBe(false)
    expect(isTransientReppoError('invalid argument --datanet')).toBe(false)
    expect(isTransientReppoError('VOTER_LACKS_SUBNET_ACCESS')).toBe(false)
  })
})

describe('runReppoStdout retry', () => {
  const noSleep = () => Promise.resolve()

  it('retries a transient failure then succeeds', async () => {
    let n = 0
    const attempt = vi.fn(async () => {
      if (++n < 3) throw new Error('PUBLIC_API_UNREACHABLE: fetch failed')
      return 'ok'
    })
    const out = await runReppoStdout(['list', 'pods'], 60_000, { attempt, sleepFn: noSleep, backoffMs: 1 })
    expect(out).toBe('ok')
    expect(attempt).toHaveBeenCalledTimes(3) // 1 + 2 retries
  })

  it('gives up after the retry budget on a persistent transient failure', async () => {
    const attempt = vi.fn(async () => { throw new Error('fetch failed') })
    await expect(runReppoStdout(['list', 'pods'], 60_000, { attempt, sleepFn: noSleep, retries: 2 }))
      .rejects.toThrow(/fetch failed/)
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry a permanent error (fails fast)', async () => {
    const attempt = vi.fn(async () => { throw new Error('CANNOT_VOTE_FOR_OWN_POD') })
    await expect(runReppoStdout(['vote'], 60_000, { attempt, sleepFn: noSleep }))
      .rejects.toThrow(/CANNOT_VOTE_FOR_OWN_POD/)
    expect(attempt).toHaveBeenCalledTimes(1)
  })
})
