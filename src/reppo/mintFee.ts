// src/reppo/mintFee.ts
// The reppo CLI's mint-pod result reports gasEth but NOT the REPPO fee (only
// grant-access does, >=0.8.4). The mint fee is per-datanet (observed 150-200
// REPPO) and is paid by the signer in the mint tx itself. To reconcile the
// ledger to the real spend, we read the tx receipt and sum the REPPO that left
// the signer's wallet — that sum IS the mint fee.

/** keccak256("Transfer(address,address,uint256)") — ERC20 Transfer topic0. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** REPPO ERC20 on Base mainnet (the platform fee asset; mint --token defaults to reppo). */
export const REPPO_TOKEN_MAINNET = '0xFf8104251E7761163faC3211eF5583FB3F8583d6'

interface Log { address: string; topics: string[]; data: string }

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
/** Decode the `from` address from an indexed Transfer topic (last 20 bytes of the 32-byte word). */
const addrFromTopic = (t: string) => '0x' + t.slice(-40)

/** Sum (in wei) the `reppoToken` transferred FROM `from` across these logs.
 *  Counts only the signer's outflow — internal fee splits made by downstream
 *  contracts (from != signer) are not the signer's cost and are excluded. */
export function sumReppoOutflow(logs: Log[], from: string, reppoToken: string): bigint {
  let total = 0n
  for (const log of logs) {
    if (!eq(log.address, reppoToken)) continue
    if (log.topics[0] !== TRANSFER_TOPIC) continue
    if (!eq(addrFromTopic(log.topics[1]), from)) continue
    total += BigInt(log.data)
  }
  return total
}

interface ReadOpts {
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Fee asset; defaults to REPPO on Base mainnet. */
  reppoToken?: string
}

async function rpcCall(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await res.json()
  return json.result
}

/** Read the actual REPPO mint fee from a landed mint tx by summing the REPPO that
 *  left the signer's wallet. Returns whole REPPO (fee assets have 18 decimals).
 *  Returns undefined on any failure (RPC down, tx not found, reverted) so the
 *  caller can fall back conservatively rather than under-count to 0. */
export async function readMintReppoFee(rpcUrl: string, txHash: string, opts: ReadOpts = {}): Promise<number | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const reppoToken = opts.reppoToken ?? REPPO_TOKEN_MAINNET
  try {
    const tx = await rpcCall(fetchImpl, rpcUrl, 'eth_getTransactionByHash', [txHash])
    if (!tx?.from) return undefined
    const receipt = await rpcCall(fetchImpl, rpcUrl, 'eth_getTransactionReceipt', [txHash])
    if (!receipt?.logs || receipt.status !== '0x1') return undefined
    const wei = sumReppoOutflow(receipt.logs, tx.from, reppoToken)
    return Number(wei / 10n ** 18n)
  } catch {
    return undefined
  }
}
