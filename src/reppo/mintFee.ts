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

/** Sum (in wei) the `reppoToken` transferred TO `to` across these logs — the mirror of
 *  sumReppoOutflow, used to read how much REPPO a claim tx paid the claimer (the CLI and
 *  PodManager V2 expose no claimed-amount, so we read it from the receipt). */
export function sumReppoInflow(logs: Log[], to: string, reppoToken: string): bigint {
  let total = 0n
  for (const log of logs) {
    if (!eq(log.address, reppoToken)) continue
    if (log.topics[0] !== TRANSFER_TOPIC) continue
    if (!eq(addrFromTopic(log.topics[2]), to)) continue // topics[2] = `to`
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

/** Single JSON-RPC POST. Exported so other readers (e.g. tokenBalance.ts) reuse the
 *  same transport/error handling rather than duplicating fetch plumbing: throws on a
 *  non-2xx response or a JSON-RPC error body so a transport failure is distinguishable
 *  from a genuine result. */
export async function rpcCall(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  // Distinguish a transport/RPC failure (rate-limit, 5xx, JSON-RPC error) from a
  // genuinely feeless tx: throw so the caller logs a distinct warning rather than
  // silently treating an error body as "no fee".
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`)
  const json = await res.json()
  if (json?.error) throw new Error(`RPC ${method} error: ${json.error.message ?? JSON.stringify(json.error)}`)
  return json.result
}

const ONE_REPPO = 10n ** 18n
const FRAC_SCALE = 10n ** 9n // 9-decimal precision for the fractional REPPO part
/** Convert wei (18-decimal) to REPPO with fractional precision. Integer REPPO comes
 *  from exact bigint division; the fractional part is scaled DOWN in bigint to 9
 *  decimals before the Number conversion, so the operand stays < 2^53 (a bare
 *  `Number(wei % ONE)` could be ~1e18, past the safe-integer limit, and lose
 *  precision — the very error this avoids). 9 decimals far exceeds REPPO fee needs. */
function weiToReppo(wei: bigint): number {
  return Number(wei / ONE_REPPO) + Number((wei % ONE_REPPO) / FRAC_SCALE) / 1e9
}

/** Read the actual REPPO mint fee from a landed mint tx by summing the REPPO that
 *  left the signer's wallet, in REPPO (fractional precision; fee assets have 18
 *  decimals). Returns undefined on any failure (RPC down, tx not found, reverted) so
 *  the caller can fall back conservatively rather than under-count to 0. */
export async function readMintReppoFee(rpcUrl: string, txHash: string, opts: ReadOpts = {}): Promise<number | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const reppoToken = opts.reppoToken ?? REPPO_TOKEN_MAINNET
  try {
    const tx = await rpcCall(fetchImpl, rpcUrl, 'eth_getTransactionByHash', [txHash])
    if (!tx?.from) return undefined
    const receipt = await rpcCall(fetchImpl, rpcUrl, 'eth_getTransactionReceipt', [txHash])
    if (!receipt?.logs || receipt.status !== '0x1') return undefined
    const wei = sumReppoOutflow(receipt.logs, tx.from, reppoToken)
    return weiToReppo(wei)
  } catch (e) {
    // A transport/RPC error (vs a feeless tx): surface it so a misconfigured or
    // rate-limited RPC is distinguishable from a genuinely zero-fee mint.
    console.warn(`orquestra: mint-fee RPC read failed for ${txHash} — ${(e as Error).message}`)
    return undefined
  }
}

/** Read the REPPO a landed claim-emissions tx actually paid the claimer, by summing the
 *  REPPO that arrived at the signer's wallet (PodManager V2 / the CLI expose no claimed
 *  amount). Returns undefined on any failure so the caller can fall back. Same signature
 *  shape as readMintReppoFee → reusable as a ReppoFeeReader. */
export async function readClaimedReppo(rpcUrl: string, txHash: string, opts: ReadOpts = {}): Promise<number | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const reppoToken = opts.reppoToken ?? REPPO_TOKEN_MAINNET
  try {
    const tx = await rpcCall(fetchImpl, rpcUrl, 'eth_getTransactionByHash', [txHash])
    if (!tx?.from) return undefined
    const receipt = await rpcCall(fetchImpl, rpcUrl, 'eth_getTransactionReceipt', [txHash])
    if (!receipt?.logs || receipt.status !== '0x1') return undefined
    const wei = sumReppoInflow(receipt.logs, tx.from, reppoToken)
    return weiToReppo(wei)
  } catch (e) {
    console.warn(`orquestra: claim-amount RPC read failed for ${txHash} — ${(e as Error).message}`)
    return undefined
  }
}
