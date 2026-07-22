// src/reppo/subnetPools.ts
// Remaining seeded rewards pool for a subnet, read straight from PodManager V2.
// Emissions are paid from per-subnet seeded balances (seedREPPOEmissions*,
// decremented on every owner/voter claim — verified on impl 0x474d4f03…), so a
// datanet with a rate but an empty pool pays NOTHING (datanet 11 died this way,
// silently). Raw JSON-RPC, no extra dep — mirrors src/reppo/epochVotes.ts.
import { POD_MANAGER_MAINNET } from './emissionsOnchain.js'

// Function selectors (stable; computed via `cast sig`).
const SEL = {
  reppoSeedings: '0x8b473a17',   // getSubnetReppoSeedings(uint256)
  primarySeedings: '0xb4025408', // getSubnetPrimaryTokenSeedings(uint256)
}

const word = (v: bigint): string => v.toString(16).padStart(64, '0')

/** eth_call returning a uint word. Throws on transport/RPC failure — the caller
 *  must treat a throw as "pool unknown this cycle", NEVER as an empty pool (a
 *  zero would mark a healthy datanet dry off an RPC blip and stop voting on it). */
async function ethCallUint(fetchImpl: typeof fetch, url: string, to: string, data: string): Promise<bigint> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  })
  if (!res.ok) throw new Error(`RPC eth_call HTTP ${res.status}`)
  const json = (await res.json()) as { result?: string; error?: { message?: string } }
  if (json?.error) throw new Error(`RPC eth_call error: ${json.error.message ?? 'unknown'}`)
  const r = json.result
  if (typeof r !== 'string' || r === '') throw new Error('RPC eth_call malformed response (no result)')
  return r === '0x' ? 0n : BigInt(r)
}

export interface SubnetPools {
  /** remaining REPPO seeding balance (raw 18-dec). */
  reppoWei: bigint
  /** remaining primary-token seeding balance (raw, token decimals). */
  primaryWei: bigint
}

export interface SubnetPoolsDeps { fetchImpl?: typeof fetch; podManager?: string }

/** 2 eth_calls per datanet per cycle. */
export async function querySubnetPools(
  rpcUrl: string,
  subnetId: string,
  deps: SubnetPoolsDeps = {},
): Promise<SubnetPools> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const pm = deps.podManager ?? POD_MANAGER_MAINNET
  const id = word(BigInt(subnetId))
  const [reppoWei, primaryWei] = await Promise.all([
    ethCallUint(fetchImpl, rpcUrl, pm, SEL.reppoSeedings + id),
    ethCallUint(fetchImpl, rpcUrl, pm, SEL.primarySeedings + id),
  ])
  return { reppoWei, primaryWei }
}
