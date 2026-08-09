// src/reppo/subnetPools.ts
// Remaining seeded rewards pool for a subnet, read straight from PodManager V2.
// Emissions are paid from per-subnet seeded balances (seedREPPOEmissions*,
// decremented on every owner/voter claim — verified on impl 0x474d4f03…), so a
// datanet with a rate but an empty pool pays NOTHING (datanet 11 died this way,
// silently). Raw JSON-RPC, no extra dep — mirrors src/reppo/epochVotes.ts.
import { networkAddresses, isRobinhood } from './network.js'
import { tryAggregate, isMulticallAvailable } from './multicall.js'
import { rpcFetch } from './rpcEndpoints.js'

// Function selectors (stable; computed via `cast sig`).
const SEL = {
  reppoSeedings: '0x8b473a17',   // getSubnetReppoSeedings(uint256)
  primarySeedings: '0xb4025408', // getSubnetPrimaryTokenSeedings(uint256)
  // PodManagerRBV1 (robinhood): ONE seeded pool per subnet, denominated in the
  // subnet token. Verified live against robinhood subnet 1, 2026-07-27.
  rbSeedings: '0xe71a6530',      // getSubnetSeedings(uint256)
}

const word = (v: bigint): string => v.toString(16).padStart(64, '0')

/** eth_call returning a uint word. Throws on transport/RPC failure — the caller
 *  must treat a throw as "pool unknown this cycle", NEVER as an empty pool (a
 *  zero would mark a healthy datanet dry off an RPC blip and stop voting on it).
 *  A 200 body with no `result` is a degraded/malformed response, NOT a zero — treat it
 *  like a transport failure so the caller reports "pool unavailable" instead of
 *  fabricating a dry pool. Only literal '0x' (empty returndata) is 0n. These are plain
 *  view getters with no legitimate revert path, so no revert/transient split is needed —
 *  every failure is a plain throw. */
async function ethCallUint(fetchImpl: typeof fetch, url: string, to: string, data: string): Promise<bigint> {
  const res = await rpcFetch(fetchImpl, url, {
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
  const pm = deps.podManager ?? networkAddresses().podManager
  const id = word(BigInt(subnetId))

  // RBV1 (robinhood): single pool in the subnet token — surfaces as primaryWei
  // (matching getSubnetEmissionInfo's mapping); the REPPO pool doesn't exist.
  if (isRobinhood()) {
    const primaryWei = await ethCallUint(fetchImpl, rpcUrl, pm, SEL.rbSeedings + id)
    return { reppoWei: 0n, primaryWei }
  }

  // Both seedings in ONE request when Multicall3 is up (view getters: an inner revert is
  // as malformed as a missing result — throw, never fabricate a dry pool).
  if (await isMulticallAvailable(rpcUrl, { fetchImpl })) {
    const [r, p] = await tryAggregate(rpcUrl, [
      { target: pm, callData: SEL.reppoSeedings + id },
      { target: pm, callData: SEL.primarySeedings + id },
    ], { fetchImpl })
    if (!r.success || !p.success) throw new Error('RPC eth_call error: seedings getter reverted in multicall')
    const toUint = (h: string): bigint => (h === '0x' ? 0n : BigInt(h))
    return { reppoWei: toUint(r.returnData), primaryWei: toUint(p.returnData) }
  }

  const [reppoWei, primaryWei] = await Promise.all([
    ethCallUint(fetchImpl, rpcUrl, pm, SEL.reppoSeedings + id),
    ethCallUint(fetchImpl, rpcUrl, pm, SEL.primarySeedings + id),
  ])
  return { reppoWei, primaryWei }
}
