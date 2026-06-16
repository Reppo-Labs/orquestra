// src/reppo/tokenBalance.ts
// Reads an ERC20 `balanceOf(owner)` via a single JSON-RPC `eth_call`, reusing the
// rpcCall plumbing from mintFee.ts (same RPC the CLI uses). Used by the cycle to
// pre-check that the wallet holds enough of a datanet's NON-REPPO primary token
// BEFORE attempting a grant the CLI would otherwise reject after spending gas.
import { rpcCall } from './mintFee.js'

/** keccak256("balanceOf(address)")[:4] — the ERC20 balanceOf selector. */
const BALANCE_OF_SELECTOR = '0x70a08231'

/** Pad a 20-byte address into a 32-byte ABI word (no 0x prefix). */
function addrWord(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

interface ReadOpts {
  /** Injected for tests; defaults to global fetch (matches mintFee.ts). */
  fetchImpl?: typeof fetch
}

/** Read an ERC20 `balanceOf(owner)` in RAW token units (no decimals scaling — the
 *  caller scales the required fee to raw units with the token's own decimals and
 *  compares directly). Throws on any RPC/transport failure or an empty result so the
 *  caller can decide whether to fall through (CLI still fails closed) rather than
 *  silently treating a failed read as a zero balance and skipping every datanet. */
export async function readTokenBalance(
  rpcUrl: string,
  token: string,
  owner: string,
  opts: ReadOpts = {},
): Promise<bigint> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const data = BALANCE_OF_SELECTOR + addrWord(owner)
  const result = await rpcCall(fetchImpl, rpcUrl, 'eth_call', [{ to: token, data }, 'latest'])
  // eth_call returns a 0x-prefixed hex word; '0x' alone (no value) means the call
  // returned nothing — treat as an error, not a 0 balance, so a bad token address
  // can't masquerade as "wallet empty" and wrongly skip the datanet.
  if (typeof result !== 'string' || result === '0x' || result === '') {
    throw new Error(`eth_call balanceOf returned no data for ${token}`)
  }
  return BigInt(result)
}
