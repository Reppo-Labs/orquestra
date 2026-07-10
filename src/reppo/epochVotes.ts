// src/reppo/epochVotes.ts
// Current-epoch vote volume for a set of pods, read straight from PodManager V2
// (getPodUpVotesOfEpoch / getPodDownVotesOfEpoch). Raw JSON-RPC, no extra dep —
// mirrors src/reppo/emissionsOnchain.ts / mintFee.ts. Used by the cycle to compute a
// datanet's real per-epoch emission yield (emission rate ÷ this epoch's vote weight);
// the catalog's lifetime upVoteVolume/downVoteVolume can't answer that (cumulative).
import { POD_MANAGER_MAINNET, VE_REPPO_MAINNET } from './emissionsOnchain.js'

// Function selectors (stable; computed via `cast sig`).
const SEL = {
  currentEpoch: '0x76671808', // currentEpoch()  (on veReppo — the source PodManager defers to)
  podUp: '0x7b9683b2',        // getPodUpVotesOfEpoch(uint256 epoch, uint256 podId)
  podDown: '0xae95ff10',      // getPodDownVotesOfEpoch(uint256 epoch, uint256 podId)
}

const word = (v: bigint): string => v.toString(16).padStart(64, '0')

/** eth_call returning a uint word. Throws on transport/RPC failure — the caller must
 *  treat a throw as "volume unavailable this cycle", NEVER as zero volume (a zero would
 *  fabricate an "uncontested" datanet out of an RPC blip). Unlike emissionsOnchain's
 *  claim probes, these are plain view getters with no legitimate revert path, so no
 *  revert/transient split is needed — every failure is a plain throw. */
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
  // A 200 body with no `result` is a degraded/malformed response, NOT a zero — treat it
  // like a transport failure so the caller reports "yield unavailable" instead of
  // fabricating an uncontested datanet. Only literal '0x' (empty returndata) is 0n.
  if (typeof r !== 'string' || r === '') throw new Error('RPC eth_call malformed response (no result)')
  return r === '0x' ? 0n : BigInt(r)
}

export interface EpochVoteVolume { epoch: number; totalRaw: bigint }
export interface EpochVotesDeps { fetchImpl?: typeof fetch; podManager?: string; veReppo?: string }

/** Σ (up+down) vote weight cast THIS epoch across `podIds`, as a raw 18-dec bigint,
 *  plus the epoch it was read at. 2 eth_calls per distinct pod (bounded by the pods the
 *  cycle already fetched for scoring). */
export async function queryEpochVoteVolume(
  rpcUrl: string,
  podIds: string[],
  deps: EpochVotesDeps = {},
): Promise<EpochVoteVolume> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const pm = deps.podManager ?? POD_MANAGER_MAINNET
  const ve = deps.veReppo ?? VE_REPPO_MAINNET
  const epoch = await ethCallUint(fetchImpl, rpcUrl, ve, SEL.currentEpoch)
  let total = 0n
  for (const podStr of [...new Set(podIds)]) {
    const podId = BigInt(podStr)
    total += await ethCallUint(fetchImpl, rpcUrl, pm, SEL.podUp + word(epoch) + word(podId))
    total += await ethCallUint(fetchImpl, rpcUrl, pm, SEL.podDown + word(epoch) + word(podId))
  }
  return { epoch: Number(epoch), totalRaw: total }
}
