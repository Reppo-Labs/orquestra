// src/reppo/votePower.ts
// The wallet's spendable vote-power budget for the CURRENT epoch, read straight from
// the chain. PodManagerV2.vote() enforces `votes + votesCasted[voter] > votingPower →
// revert InsufficientVotingPower` (per-epoch ledger, verified on impl 0x474d4f03…), so
// the real budget is votingPowerOf(wallet) − votesCastedByVoterForEpoch(wallet, epoch).
// epochEnd(epoch) is read alongside so the caller can pace spending over the time left.
// Raw JSON-RPC, no extra dep — mirrors src/reppo/epochVotes.ts.
import { POD_MANAGER_MAINNET, VE_REPPO_MAINNET } from './emissionsOnchain.js'

// Function selectors (stable; computed via `cast sig`).
const SEL = {
  votingPowerOf: '0xbcc3f3bd', // votingPowerOf(address)                       (veReppo)
  currentEpoch: '0x76671808',  // currentEpoch()                               (veReppo)
  epochEnd: '0xd9be1efe',      // epochEnd(uint256 epoch)                      (veReppo)
  votesCasted: '0x3827cb73',   // votesCastedByVoterForEpoch(address,uint256)  (PodManager)
}

const word = (v: bigint): string => v.toString(16).padStart(64, '0')
const addrWord = (a: string): string => a.replace(/^0x/i, '').toLowerCase().padStart(64, '0')

/** eth_call returning a uint word. Throws on transport/RPC failure — the caller must
 *  treat a throw as "budget unavailable this cycle" (legacy vote sizing), NEVER as a
 *  zero budget (that would silently stop all voting on an RPC blip). Plain view
 *  getters with no legitimate revert path — every failure is a plain throw. */
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

export interface VotePowerBudget {
  /** wallet's full veREPPO voting power (raw 18-dec). */
  votingPowerWei: bigint
  /** votes already spent THIS epoch (raw 18-dec — the contract ledgers the UNDECAYED amount). */
  votesCastedWei: bigint
  /** spendable remainder: votingPower − votesCasted, floored at 0n. */
  remainingWei: bigint
  epoch: number
  /** unix second the current epoch ends (veReppo.epochEnd) — pacing input. */
  epochEndsAtSec: number
}

export interface VotePowerDeps { fetchImpl?: typeof fetch; podManager?: string; veReppo?: string }

/** 4 eth_calls: currentEpoch → (votingPowerOf, votesCasted, epochEnd). */
export async function queryVotePowerBudget(
  rpcUrl: string,
  wallet: string,
  deps: VotePowerDeps = {},
): Promise<VotePowerBudget> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const pm = deps.podManager ?? POD_MANAGER_MAINNET
  const ve = deps.veReppo ?? VE_REPPO_MAINNET

  const epoch = await ethCallUint(fetchImpl, rpcUrl, ve, SEL.currentEpoch)
  const [votingPowerWei, votesCastedWei, epochEndsAt] = await Promise.all([
    ethCallUint(fetchImpl, rpcUrl, ve, SEL.votingPowerOf + addrWord(wallet)),
    ethCallUint(fetchImpl, rpcUrl, pm, SEL.votesCasted + addrWord(wallet) + word(epoch)),
    ethCallUint(fetchImpl, rpcUrl, ve, SEL.epochEnd + word(epoch)),
  ])
  const remainingWei = votingPowerWei > votesCastedWei ? votingPowerWei - votesCastedWei : 0n
  return {
    votingPowerWei,
    votesCastedWei,
    remainingWei,
    epoch: Number(epoch),
    epochEndsAtSec: Number(epochEndsAt),
  }
}
