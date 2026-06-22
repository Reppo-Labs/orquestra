// src/reppo/emissionsOnchain.ts
// On-chain claimable-emissions detection. The reppo platform API (`query emissions-due`)
// under-reports — it returned an empty list while 20 (pod,epoch) pairs were claimable
// on-chain — so the node reads PodManager V2 directly instead of trusting it.
//
// PodManager V2 exposes no per-pod "emissions due" view, but it does expose:
//   - hasPodOwnerClaimedEmissions(epoch, podId) view -> bool
//   - claimPodOwnerEmissions(podId, epoch)           -> reverts when nothing is due
// so a (pod,epoch) is claimable iff NOT already claimed AND an eth_call of the claim
// does not revert. Pods we own are enumerated from ERC-721 Transfer logs (to our
// wallet), cached in the DB and extended incrementally. Raw JSON-RPC (no extra dep),
// mirroring src/reppo/mintFee.ts.
import type { ClaimableEmission } from './queryEmissionsDue.js'

export const POD_MANAGER_MAINNET = '0x5C563f853eb4db33005A5C1aD9290e8560254A80'
export const VE_REPPO_MAINNET = '0x0EFBE19Cb7B07D934D01990a8989E9CaA98b9009'
/** keccak256("Transfer(address,address,uint256)") — ERC721 Transfer topic0. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
// Function selectors (stable; computed via viem toFunctionSelector).
const SEL = {
  hasClaimed: '0x5b778a36', // hasPodOwnerClaimedEmissions(uint256 epoch, uint256 podId)
  claim: '0x6dd6f4c9',      // claimPodOwnerEmissions(uint256 podId, uint256 epoch)
  currentEpoch: '0x76671808', // currentEpoch()  (on veReppo)
  hasVoterClaimed: '0xec1e3908', // hasUserClaimedEmissions(uint256 epoch, uint256 podId, address user)
  claimVoter: '0x971a6c50',      // claimVoterEmissions(address voter, uint256 podId, uint256 epoch)
  votesCasted: '0x3827cb73',     // votesCastedByVoterForEpoch(address voter, uint256 epoch)
}
/** Left-pad an address to a 32-byte ABI word. */
const addrWord = (addr: string): string => addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')
/** First-run block lookback when no scan checkpoint exists (~Base 2s blocks → ~3 months). */
const INITIAL_LOOKBACK_BLOCKS = 4_000_000n
// eth_getLogs block-range cap. Most public RPCs (incl. mainnet.base.org) reject ranges
// wider than ~10k blocks with HTTP 400; the old 40k chunk failed the whole emissions scan
// on the default RPC. 9_000 (→ 9_001-block spans) stays under the common cap. Discovery is
// incremental + cached, so the extra requests only hit the one-time first-run backfill.
const LOG_CHUNK = 9_000n

const word = (v: bigint): string => v.toString(16).padStart(64, '0')
const hexBlock = (b: bigint): string => '0x' + b.toString(16)
const topicForAddress = (addr: string): string => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')

interface Log { topics: string[]; data: string }
/** ERC721 Transfer: tokenId is the 3rd indexed topic. */
export const tokenIdFromLog = (log: Log): bigint => BigInt(log.topics[3])

interface RpcDeps {
  fetchImpl?: typeof fetch
  podManager?: string
  veReppo?: string
  /** epochs back from current to scan for unclaimed emissions (default 3). */
  lookbackEpochs?: number
  /** Lowest epoch the voter scan will ever check (default 1). The node never earns voter
   *  emissions before it existed, so a floor (e.g. the epoch it first voted) bounds the
   *  first-run deep scan instead of crawling from epoch 1. */
  floorEpoch?: number
}

async function rpcCall(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`)
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } }
  if (json?.error) throw new Error(`RPC ${method} error: ${json.error.message ?? 'unknown'}`)
  return json.result
}

/** eth_call; returns the raw hex result, or throws if the call reverts (used as the
 *  claimable oracle: a claim that reverts is "nothing due"). */
async function ethCall(fetchImpl: typeof fetch, url: string, to: string, data: string, from?: string): Promise<string> {
  const call: Record<string, string> = { to, data }
  if (from) call.from = from
  return (await rpcCall(fetchImpl, url, 'eth_call', [call, 'latest'])) as string
}

const isTrue = (hex: string): boolean => /[1-9a-f]/i.test((hex || '').replace(/^0x/, '')) // any nonzero word

/** Enumerate pod tokenIds ever transferred TO `wallet`, scanning [fromBlock, toBlock]
 *  in chunks. All IO via rpcCall. */
export async function discoverOwnedPods(
  fetchImpl: typeof fetch, url: string, podManager: string, wallet: string, fromBlock: bigint, toBlock: bigint,
): Promise<bigint[]> {
  const ids = new Set<bigint>()
  for (let b = fromBlock; b <= toBlock; b += LOG_CHUNK + 1n) {
    const to = b + LOG_CHUNK < toBlock ? b + LOG_CHUNK : toBlock
    const logs = (await rpcCall(fetchImpl, url, 'eth_getLogs', [{
      address: podManager,
      topics: [TRANSFER_TOPIC, null, topicForAddress(wallet)],
      fromBlock: hexBlock(b), toBlock: hexBlock(to),
    }])) as Log[]
    for (const l of logs) ids.add(tokenIdFromLog(l))
  }
  return [...ids]
}

/** Cache callbacks so the orchestrator is testable without the DB. */
export interface PodCache {
  getKnownPods(): string[]
  addPods(ids: string[]): void
  getLastBlock(): bigint | null
  setLastBlock(b: bigint): void
}

/** Detect claimable (pod,epoch) on-chain. Enumerates new pods since the cached block,
 *  then for every owned pod checks the last `lookbackEpochs` closed epochs: unclaimed +
 *  a non-reverting claim eth_call ⇒ claimable. Returns ClaimableEmission[] (reppo amount
 *  unknown pre-claim — PodManager V2 has no amount view — so 0; the chain pays what is
 *  owed on claim). Best-effort: the caller wraps this and tolerates a throw. */
export async function queryClaimableOnchain(rpcUrl: string, wallet: string, cache: PodCache, deps: RpcDeps = {}): Promise<ClaimableEmission[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const pm = deps.podManager ?? POD_MANAGER_MAINNET
  const ve = deps.veReppo ?? VE_REPPO_MAINNET
  const lookback = BigInt(deps.lookbackEpochs ?? 3)

  // 1. incremental pod discovery
  const latest = BigInt((await rpcCall(fetchImpl, rpcUrl, 'eth_blockNumber', [])) as string)
  const last = cache.getLastBlock()
  const from = last !== null ? last + 1n : (latest > INITIAL_LOOKBACK_BLOCKS ? latest - INITIAL_LOOKBACK_BLOCKS : 0n)
  if (from <= latest) {
    const fresh = await discoverOwnedPods(fetchImpl, rpcUrl, pm, wallet, from, latest)
    if (fresh.length) cache.addPods(fresh.map(String))
    cache.setLastBlock(latest)
  }

  // 2. current epoch (veReppo is the authoritative source PodManager defers to)
  const cur = BigInt(await ethCall(fetchImpl, rpcUrl, ve, SEL.currentEpoch))

  // 3. for each owned pod, scan the recent CLOSED epochs for an unclaimed, non-reverting claim
  const out: ClaimableEmission[] = []
  const start = cur > lookback ? cur - lookback : 1n
  for (const podStr of cache.getKnownPods()) {
    const podId = BigInt(podStr)
    for (let ep = start; ep < cur; ep++) {
      const claimed = await ethCall(fetchImpl, rpcUrl, pm, SEL.hasClaimed + word(ep) + word(podId))
      if (isTrue(claimed)) continue
      try {
        await ethCall(fetchImpl, rpcUrl, pm, SEL.claim + word(podId) + word(ep), wallet) // reverts ⇒ nothing due
      } catch { continue }
      out.push({ podId: podStr, datanetId: '', epoch: Number(ep), reppo: 0 })
    }
  }
  return out
}

/** Per-pod watermark: the highest CLOSED epoch already scanned for voter emissions, so the
 *  first run deep-scans full history and later runs only check new epochs. */
export interface VoterScanCache {
  getThrough(podId: string): number
  setThrough(podId: string, epoch: number): void
}

/** Detect claimable VOTER (pod,epoch) on-chain. The pod set is the pods the wallet VOTED on
 *  (from the node's executed-vote activity — the wallet doesn't own them, so they're absent
 *  from the owner Transfer-log cache). For each (pod,epoch): NOT-yet-claimed
 *  (hasUserClaimedEmissions) AND a non-reverting claimVoterEmissions eth_call ⇒ claimable.
 *  The eth_call reverts when nothing is due for this voter at this (pod,epoch) — verified the
 *  authoritative signal on mainnet (a not-due claim reverts; a closed, earned epoch does not).
 *  We deliberately do NOT pre-gate on getVotersUpVotesForPodInEpoch: on-chain that view reads 0
 *  even for the wallet's counted votes, so gating on it would skip legitimate claims — and a
 *  rare succeed-at-0 claim only wastes negligible Base gas, far cheaper than dropping real REPPO.
 *
 *  COST CONTROL — the (pod × epoch) eth_call grid is bounded two ways so a first run doesn't
 *  storm the public RPC (which throttled it into a partial scan):
 *   1. `floorEpoch` — never scan below the epoch the node first existed (default 1).
 *   2. ACTIVE-epoch gate — a voter only earns at an epoch it voted in, so we compute
 *      votesCastedByVoterForEpoch(wallet, ep) ONCE per epoch in [floor, lastClosed] and check
 *      pods only at epochs where it is > 0. This is lossless (a claim at ep ⟹ wallet voted at
 *      ep ⟹ votesCasted(ep) > 0) and collapses ~(pods × allEpochs) to (pods × activeEpochs).
 *
 *  `cache` makes the scan incremental: the watermark resumes past already-scanned epochs.
 *  Amount is unknown pre-claim (0); the chain pays what's owed. */
export async function queryVoterClaimableOnchain(
  rpcUrl: string, wallet: string, votedPodIds: string[], cache?: VoterScanCache, deps: RpcDeps = {},
): Promise<ClaimableEmission[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const pm = deps.podManager ?? POD_MANAGER_MAINNET
  const ve = deps.veReppo ?? VE_REPPO_MAINNET
  const floor = BigInt(deps.floorEpoch ?? 1)
  if (votedPodIds.length === 0) return []

  const cur = BigInt(await ethCall(fetchImpl, rpcUrl, ve, SEL.currentEpoch))
  if (cur <= 1n) return [] // no closed epochs yet
  const w = addrWord(wallet)
  const out: ClaimableEmission[] = []
  const lastClosed = cur - 1n
  const scanFrom = floor > 1n ? floor : 1n

  // Active closed epochs the wallet voted in (votesCasted > 0) — computed ONCE, shared by all
  // pods. A pod can only have a voter reward at an epoch the wallet voted, so this prunes the
  // grid without dropping any real claim.
  const activeEpochs: bigint[] = []
  for (let ep = scanFrom; ep <= lastClosed; ep++) {
    const cast = await ethCall(fetchImpl, rpcUrl, pm, SEL.votesCasted + w + word(ep)).catch(() => '0x')
    if (isTrue(cast)) activeEpochs.push(ep)
  }
  if (activeEpochs.length === 0) return []

  for (const podStr of [...new Set(votedPodIds)]) {
    const podId = BigInt(podStr)
    // Resume past the watermark (highest closed epoch already scanned); first run → from floor.
    const through = cache ? BigInt(cache.getThrough(podStr)) : 0n
    let firstClaimable: bigint | null = null
    for (const ep of activeEpochs) {
      if (ep <= through) continue
      // hasUserClaimedEmissions(epoch, podId, user)
      const claimed = await ethCall(fetchImpl, rpcUrl, pm, SEL.hasVoterClaimed + word(ep) + word(podId) + w)
      if (isTrue(claimed)) continue
      try {
        // claimVoterEmissions(voter, podId, epoch) — reverts ⇒ nothing due for this voter
        await ethCall(fetchImpl, rpcUrl, pm, SEL.claimVoter + w + word(podId) + word(ep), wallet)
      } catch { continue }
      if (firstClaimable === null) firstClaimable = ep
      out.push({ podId: podStr, datanetId: '', epoch: Number(ep), reppo: 0 })
    }
    // Advance the watermark to JUST BEFORE the oldest still-claimable epoch (or the last closed
    // epoch when nothing is due). Not past a claimable-but-unclaimed epoch — its claim happens
    // after detection and may fail transiently, so it must stay re-checkable until on-chain
    // hasUserClaimedEmissions flips true (then a later run advances past it).
    const newThrough = firstClaimable !== null ? firstClaimable - 1n : lastClosed
    if (newThrough > through) cache?.setThrough(podStr, Number(newThrough))
  }
  return out
}
