// src/reppo/subnetManager.ts
// Reads the Reppo SubnetManager (Base mainnet) to resolve a subnet's emission token and
// per-epoch emission amounts. The PodManager defers to SubnetManager at claim time:
//   claimVoterEmissions/claimPodOwnerEmissions pay REPPO and/or the subnet's primary token,
//   gated on getReppoEmissionsPerEpoch / getPrimaryTokenEmissionsPerEpoch being > 0.
// Raw JSON-RPC eth_call (no extra dep), mirroring src/reppo/emissionsOnchain.ts.

export const SUBNET_MANAGER_MAINNET = '0x2629a8083065938b533b117704935d727270ee7a'

// Function selectors (viem toFunctionSelector; verified live against subnet 22 / Litebeam).
const SEL = {
  primaryToken: '0x0d1b89d8', // getSubnetPrimaryToken(uint256) -> address
  primaryEmissions: '0x9f9a490b', // getPrimaryTokenEmissionsPerEpoch(uint256) -> uint256
  reppoEmissions: '0xd323657d', // getReppoEmissionsPerEpoch(uint256) -> uint256
}

const word = (v: bigint): string => v.toString(16).padStart(64, '0')

async function ethCall(fetchImpl: typeof fetch, url: string, to: string, data: string): Promise<string> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  })
  if (!res.ok) throw new Error(`RPC eth_call HTTP ${res.status}`)
  const json = (await res.json()) as { result?: string; error?: { message?: string } }
  if (json?.error) throw new Error(`RPC eth_call error: ${json.error.message ?? 'unknown'}`)
  return json.result ?? '0x'
}

/** ABI address word → lowercase 0x address (low 20 bytes). */
const addressFromWord = (hex: string): string => {
  const h = (hex || '').replace(/^0x/, '').padStart(64, '0')
  return '0x' + h.slice(-40)
}
const toBigInt = (hex: string): bigint => (hex && hex !== '0x' ? BigInt(hex) : 0n)

export interface SubnetEmissionInfo {
  /** primary (native) emission token address; ZERO_ADDRESS when the subnet has none. */
  primaryToken: string
  /** raw per-epoch primary-token emissions (token base units). */
  primaryEmissionsPerEpoch: bigint
  /** raw per-epoch REPPO emissions (18-decimal base units). */
  reppoEmissionsPerEpoch: bigint
}

export interface SubnetManagerDeps {
  fetchImpl?: typeof fetch
  subnetManager?: string
}

/** Resolve a subnet's emission token + per-epoch amounts from the SubnetManager. Throws on
 *  RPC failure — callers that treat this as best-effort should wrap it. */
export async function getSubnetEmissionInfo(
  rpcUrl: string,
  subnetId: string | number | bigint,
  deps: SubnetManagerDeps = {},
): Promise<SubnetEmissionInfo> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sm = deps.subnetManager ?? SUBNET_MANAGER_MAINNET
  const arg = word(BigInt(subnetId))
  const [tokenHex, primaryHex, reppoHex] = await Promise.all([
    ethCall(fetchImpl, rpcUrl, sm, SEL.primaryToken + arg),
    ethCall(fetchImpl, rpcUrl, sm, SEL.primaryEmissions + arg),
    ethCall(fetchImpl, rpcUrl, sm, SEL.reppoEmissions + arg),
  ])
  return {
    primaryToken: addressFromWord(tokenHex),
    primaryEmissionsPerEpoch: toBigInt(primaryHex),
    reppoEmissionsPerEpoch: toBigInt(reppoHex),
  }
}

/** Format a raw token amount to a display number using its decimals. Approximate (float) —
 *  for human-readable rationale/labels only, never for balance/spend math. */
export function formatTokenAmount(raw: bigint, decimals: number): number {
  if (!Number.isFinite(decimals) || decimals < 0) return Number(raw)
  return Number(raw) / 10 ** decimals
}
