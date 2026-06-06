// src/reppo/exec.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { reppoEnv, withRpcUrl } from './exec.js'

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
