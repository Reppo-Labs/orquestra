// src/reppo/mintFee.test.ts
import { describe, it, expect } from 'vitest'
import { sumReppoOutflow, readMintReppoFee, REPPO_TOKEN_MAINNET } from './mintFee.js'

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const WALLET = '0xb4EC41c93cF2f573f82D8F023B01637Eb5dB4c64'
const POD_MGR = '0x5c563f853eb4db33005a5c1ad9290e8560254a80'
const OTHER_TOKEN = '0x0000000000000000000000000000000000009999'

// Pad a 20-byte address into a 32-byte ERC20 Transfer topic.
const topic = (addr: string) => '0x' + '0'.repeat(24) + addr.toLowerCase().replace(/^0x/, '')
// Encode a REPPO amount (whole tokens, 18 decimals) as the Transfer `data` word.
const amount = (whole: bigint) => '0x' + (whole * 10n ** 18n).toString(16).padStart(64, '0')

const transferLog = (token: string, from: string, to: string, whole: bigint) => ({
  address: token,
  topics: [TRANSFER, topic(from), topic(to)],
  data: amount(whole),
})

describe('sumReppoOutflow', () => {
  it('sums REPPO transferred FROM the signer (the mint fee)', () => {
    const logs = [transferLog(REPPO_TOKEN_MAINNET, WALLET, POD_MGR, 150n)]
    expect(sumReppoOutflow(logs, WALLET, REPPO_TOKEN_MAINNET)).toBe(150n * 10n ** 18n)
  })

  it('ignores transfers of a different token', () => {
    const logs = [transferLog(OTHER_TOKEN, WALLET, POD_MGR, 999n)]
    expect(sumReppoOutflow(logs, WALLET, REPPO_TOKEN_MAINNET)).toBe(0n)
  })

  it('ignores REPPO transfers NOT from the signer (internal fee splits)', () => {
    const logs = [
      transferLog(REPPO_TOKEN_MAINNET, WALLET, POD_MGR, 150n), // signer pays
      transferLog(REPPO_TOKEN_MAINNET, POD_MGR, OTHER_TOKEN, 15n), // internal split — must not count
      transferLog(REPPO_TOKEN_MAINNET, POD_MGR, WALLET, 135n), // internal split — must not count
    ]
    expect(sumReppoOutflow(logs, WALLET, REPPO_TOKEN_MAINNET)).toBe(150n * 10n ** 18n)
  })

  it('sums multiple signer outflows in one tx', () => {
    const logs = [
      transferLog(REPPO_TOKEN_MAINNET, WALLET, POD_MGR, 100n),
      transferLog(REPPO_TOKEN_MAINNET, WALLET, OTHER_TOKEN, 50n),
    ]
    expect(sumReppoOutflow(logs, WALLET, REPPO_TOKEN_MAINNET)).toBe(150n * 10n ** 18n)
  })

  it('is case-insensitive on addresses', () => {
    const logs = [transferLog(REPPO_TOKEN_MAINNET.toUpperCase(), WALLET.toLowerCase(), POD_MGR, 200n)]
    expect(sumReppoOutflow(logs, WALLET.toUpperCase(), REPPO_TOKEN_MAINNET)).toBe(200n * 10n ** 18n)
  })

  it('returns 0 when there are no logs', () => {
    expect(sumReppoOutflow([], WALLET, REPPO_TOKEN_MAINNET)).toBe(0n)
  })

  it('ignores non-Transfer logs on the REPPO token (e.g. Approval)', () => {
    const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
    const logs = [{ address: REPPO_TOKEN_MAINNET, topics: [APPROVAL, topic(WALLET), topic(POD_MGR)], data: amount(150n) }]
    expect(sumReppoOutflow(logs, WALLET, REPPO_TOKEN_MAINNET)).toBe(0n)
  })
})

// A fake JSON-RPC endpoint: maps method -> result. Mirrors the two calls the
// reader makes (eth_getTransactionByHash for the signer, eth_getTransactionReceipt
// for the logs).
const fakeRpc = (byHash: unknown, receipt: unknown) =>
  (async (_url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body)
    const result = method === 'eth_getTransactionByHash' ? byHash : method === 'eth_getTransactionReceipt' ? receipt : null
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }
  }) as unknown as typeof fetch

const txOf = (from: string) => ({ from, hash: '0xmint' })
const receiptOf = (logs: unknown[], status = '0x1') => ({ status, logs })

describe('readMintReppoFee', () => {
  it('returns the REPPO fee (whole tokens) the signer paid in the mint tx', async () => {
    const logs = [transferLog(REPPO_TOKEN_MAINNET, WALLET, POD_MGR, 150n)]
    const fee = await readMintReppoFee('https://rpc', '0xmint', { fetchImpl: fakeRpc(txOf(WALLET), receiptOf(logs)) })
    expect(fee).toBe(150)
  })

  it('returns undefined when the receipt status is failed (reverted tx pays no fee)', async () => {
    const logs = [transferLog(REPPO_TOKEN_MAINNET, WALLET, POD_MGR, 150n)]
    const fee = await readMintReppoFee('https://rpc', '0xmint', { fetchImpl: fakeRpc(txOf(WALLET), receiptOf(logs, '0x0')) })
    expect(fee).toBeUndefined()
  })

  it('returns undefined when fetch throws (RPC unreachable)', async () => {
    const throwing = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const fee = await readMintReppoFee('https://rpc', '0xmint', { fetchImpl: throwing })
    expect(fee).toBeUndefined()
  })

  it('returns undefined when the tx is not found (null result)', async () => {
    const fee = await readMintReppoFee('https://rpc', '0xmint', { fetchImpl: fakeRpc(null, null) })
    expect(fee).toBeUndefined()
  })
})
