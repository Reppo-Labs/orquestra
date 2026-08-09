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
import { networkAddresses } from './network.js'
import { tryAggregate, isMulticallAvailable, type Call3Result } from './multicall.js'
import { rpcFetch } from './rpcEndpoints.js'

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
  voterUp: '0x08856f83',         // getVotersUpVotesForPodInEpoch(uint256 epoch, uint256 podId, address voter)
  voterDown: '0x8c03a3e7',       // getVotersDownVotesForPodInEpoch(uint256 epoch, uint256 podId, address voter)
}
/** Read a uint256 view via eth_call → bigint. Empty returndata ('0x') and a contract
 *  REVERT are genuine zeros. A TRANSIENT failure (HTTP 5xx, rate limit, timeout, all
 *  endpoints down) is NOT: it propagates.
 *
 *  This used to be a blanket `catch { return 0n }`, which quietly cost money. The only
 *  caller is the voter scan's per-pod vote gate (voterUp/voterDown): a fabricated 0 there
 *  reads as "the wallet cast no votes on this pod at this epoch", so the (pod,epoch) is
 *  skipped AND — because nothing was found claimable — the watermark advances past it.
 *  One RPC blip therefore burned a real, claimable voter reward PERMANENTLY. Same
 *  fail-open discipline as every other read in the node: an UNREAD value must never
 *  become a zero that silences work. */
async function readUint(fetchImpl: typeof fetch, url: string, to: string, data: string): Promise<bigint> {
  try {
    const r = await ethCall(fetchImpl, url, to, data)
    return r && r !== '0x' ? BigInt(r) : 0n
  } catch (e) {
    if (e instanceof RpcRevertError) return 0n // contract answered: nothing recorded
    throw e // transient: abort the scan before any watermark advances
  }
}
/** Left-pad an address to a 32-byte ABI word. */
const addrWord = (addr: string): string => addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')
/** First-run block lookback when no scan checkpoint exists (~Base 2s blocks → ~3 months). */
const INITIAL_LOOKBACK_BLOCKS = 4_000_000n
// eth_getLogs block-range cap. Most public RPCs (incl. mainnet.base.org) reject ranges
// wider than ~10k blocks with HTTP 400; the old 40k chunk failed the whole emissions scan
// on the default RPC. 9_000 (→ 9_001-block spans) stays under the common cap — but some
// free tiers cap tighter (1k-5k), which failed EVERY cycle's owner-claim scan with HTTP
// 400 (live incident: an operator on such a provider had owner emissions stuck unclaimed
// for a week). The scan now ADAPTS: a range-cap rejection halves the chunk (floor 500)
// and retries the same window; the reduced size sticks for the rest of that scan.
// Non-range failures (5xx, rate limits, timeouts) still fail fast — the caller retries
// next cycle, and mistaking an outage for a cap would shrink-and-hammer a downed node.
const LOG_CHUNK = 9_000n
const MIN_LOG_CHUNK = 500n

/** Does this error look like the provider rejecting the REQUEST SHAPE (block range too
 *  wide) rather than being down? Providers signal a range cap as HTTP 400/413/414 or a
 *  JSON-RPC error naming the range/limit. Deliberately narrow: 5xx and rate limits must
 *  NOT match (see LOG_CHUNK note). */
const isRangeCapError = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message : String(e)
  return /HTTP 4(00|13|14)\b/.test(msg) || /\brange\b|limit exceeded|too (large|many|wide)|exceeds/i.test(msg)
}

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

/** A contract-level EVM revert (the JSON-RPC node executed the call and it reverted). Used as
 *  the "nothing due" oracle for claim probes. Distinct from a transient transport failure
 *  (HTTP 5xx, rate limit, timeout) — the latter must NOT be read as "nothing due", or a
 *  claimable epoch gets silently skipped and, with a watermark, permanently lost. */
export class RpcRevertError extends Error {
  constructor(message: string) { super(message); this.name = 'RpcRevertError' }
}

/** Does this JSON-RPC error describe an EVM revert (deterministic, from the contract) rather
 *  than a transient node failure? Revert surfaces as code 3 (eth spec) or a message the node
 *  tags with "revert"/"execution reverted". Rate limits (-32005/-32029), timeouts and 5xx are
 *  transient and fall through to a plain Error. */
const isRevert = (code: number | undefined, msg: string): boolean =>
  code === 3 || /revert|invalid opcode|out of gas|always failing/i.test(msg)

async function rpcCall(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await rpcFetch(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`) // transient (server/network)
  const json = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } }
  if (json?.error) {
    const msg = json.error.message ?? 'unknown'
    // A contract revert is a meaningful "nothing due"; anything else is transient and must
    // propagate so the caller retries instead of treating it as an empty result.
    if (isRevert(json.error.code, msg)) throw new RpcRevertError(`RPC ${method} reverted: ${msg}`)
    throw new Error(`RPC ${method} error: ${msg}`)
  }
  return json.result
}

/** eth_call; returns the raw hex result. Throws RpcRevertError if the call reverts (the
 *  claimable oracle: a claim that reverts is "nothing due"); throws a plain Error on a
 *  transient transport failure (which the caller must not read as "nothing due"). */
async function ethCall(fetchImpl: typeof fetch, url: string, to: string, data: string, from?: string): Promise<string> {
  const call: Record<string, string> = { to, data }
  if (from) call.from = from
  return (await rpcCall(fetchImpl, url, 'eth_call', [call, 'latest'])) as string
}

const isTrue = (hex: string): boolean => /[1-9a-f]/i.test((hex || '').replace(/^0x/, '')) // any nonzero word

/** Enumerate pod tokenIds ever transferred TO `wallet`, scanning [fromBlock, toBlock]
 *  in chunks. All IO via rpcCall. Chunk size adapts downward when the provider rejects
 *  the range (see LOG_CHUNK note); the reduced size persists for the rest of the scan. */
export async function discoverOwnedPods(
  fetchImpl: typeof fetch, url: string, podManager: string, wallet: string, fromBlock: bigint, toBlock: bigint,
): Promise<bigint[]> {
  const ids = new Set<bigint>()
  let chunk = LOG_CHUNK
  let b = fromBlock
  while (b <= toBlock) {
    const to = b + chunk < toBlock ? b + chunk : toBlock
    let logs: Log[]
    try {
      logs = (await rpcCall(fetchImpl, url, 'eth_getLogs', [{
        address: podManager,
        topics: [TRANSFER_TOPIC, null, topicForAddress(wallet)],
        fromBlock: hexBlock(b), toBlock: hexBlock(to),
      }])) as Log[]
    } catch (e) {
      if (isRangeCapError(e) && chunk > MIN_LOG_CHUNK) {
        chunk = chunk / 2n < MIN_LOG_CHUNK ? MIN_LOG_CHUNK : chunk / 2n
        continue // retry the SAME window at the smaller span
      }
      throw e // at the floor, or a transient failure — the caller retries next cycle
    }
    for (const l of logs) ids.add(tokenIdFromLog(l))
    b = to + 1n
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

/** Per-pod watermark: the highest CLOSED epoch already scanned for emissions, so the
 *  first run deep-scans full history and later runs only check new epochs. Shared by the
 *  owner-claim and voter-claim scanners (each with its own DB table). */
export interface EpochScanCache {
  getThrough(podId: string): number
  setThrough(podId: string, epoch: number): void
}
/** Back-compat alias — the voter scanner predates the shared name. */
export type VoterScanCache = EpochScanCache

/** Detect claimable OWNER (pod,epoch) on-chain. Enumerates new pods since the cached block,
 *  then scans each owned pod's CLOSED epochs: unclaimed + a non-reverting claim eth_call ⇒
 *  claimable. Returns ClaimableEmission[] (reppo amount unknown pre-claim — PodManager V2
 *  has no amount view — so 0; the chain pays what is owed on claim).
 *
 *  With `scanCache` (production): per-pod watermark — the FIRST run deep-scans from
 *  `floorEpoch` (default 1) through the last closed epoch, so emissions older than the old
 *  3-epoch window are found and claimed (operator report: the node claimed once, then old
 *  epochs sat outside the window forever and needed manual claims). Later runs resume past
 *  the watermark. The watermark never advances past a claimable-but-unclaimed epoch — its
 *  claim happens after detection and may fail transiently, so it stays re-checkable until
 *  hasPodOwnerClaimedEmissions flips true on-chain.
 *
 *  Without `scanCache` (legacy/tests): the fixed `lookbackEpochs` window (default 3).
 *  Best-effort: the caller wraps this and tolerates a throw. */
export async function queryClaimableOnchain(
  rpcUrl: string, wallet: string, cache: PodCache, deps: RpcDeps = {}, scanCache?: EpochScanCache,
): Promise<ClaimableEmission[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const pm = deps.podManager ?? networkAddresses().podManager
  const ve = deps.veReppo ?? networkAddresses().veReppo
  const lookback = BigInt(deps.lookbackEpochs ?? 3)
  const floor = BigInt(deps.floorEpoch ?? 1)

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
  if (cur <= 1n) return [] // no closed epochs yet
  const lastClosed = cur - 1n
  const windowStart = cur > lookback ? cur - lookback : 1n

  // 3. for each owned pod, scan CLOSED epochs for an unclaimed, non-reverting claim
  const out: ClaimableEmission[] = []
  const pods = cache.getKnownPods()
  const startFor = (podStr: string): bigint => {
    const through = scanCache ? BigInt(scanCache.getThrough(podStr)) : 0n
    const resume = through + 1n > floor ? through + 1n : floor
    return scanCache ? resume : windowStart
  }
  // Batched claim-STATUS grid: hasPodOwnerClaimedEmissions is a plain view (no msg.sender),
  // so the whole (pod × epoch) grid collapses into ⌈pairs/200⌉ requests. The claim PROBE
  // below stays serial — its revert oracle needs `from: wallet` (see multicall.ts header).
  let claimedByPair: Map<string, boolean> | null = null
  if (await isMulticallAvailable(rpcUrl, { fetchImpl })) {
    const pairs: { pod: string; ep: bigint }[] = []
    for (const podStr of pods) for (let ep = startFor(podStr); ep <= lastClosed; ep++) pairs.push({ pod: podStr, ep })
    claimedByPair = new Map()
    if (pairs.length > 0) {
      const res = await tryAggregate(rpcUrl, pairs.map(({ pod, ep }) =>
        ({ target: pm, callData: SEL.hasClaimed + word(ep) + word(BigInt(pod)) })), { fetchImpl })
      pairs.forEach(({ pod, ep }, i) => {
        // A view with no legitimate revert path reverting inside the batch is as malformed
        // as a missing result — abort before any watermark advances, exactly like a serial
        // transient failure would.
        if (!res[i].success) throw new Error('RPC eth_call error: hasPodOwnerClaimedEmissions reverted in multicall')
        claimedByPair!.set(`${pod}|${ep}`, isTrue(res[i].returnData))
      })
    }
  }
  for (const podStr of pods) {
    const podId = BigInt(podStr)
    const through = scanCache ? BigInt(scanCache.getThrough(podStr)) : 0n
    const start = startFor(podStr)
    let firstClaimable: bigint | null = null
    for (let ep = start; ep <= lastClosed; ep++) {
      const claimed = claimedByPair
        ? claimedByPair.get(`${podStr}|${ep}`) === true
        : isTrue(await ethCall(fetchImpl, rpcUrl, pm, SEL.hasClaimed + word(ep) + word(podId)))
      if (claimed) continue
      try {
        await ethCall(fetchImpl, rpcUrl, pm, SEL.claim + word(podId) + word(ep), wallet)
      } catch (e) {
        if (e instanceof RpcRevertError) continue // reverts ⇒ nothing due for this (pod,epoch)
        throw e // transient RPC failure: abort before the watermark advances, so this epoch stays re-checkable next cycle
      }
      if (firstClaimable === null) firstClaimable = ep
      out.push({ podId: podStr, datanetId: '', epoch: Number(ep), reppo: 0 })
    }
    if (scanCache) {
      const newThrough = firstClaimable !== null ? firstClaimable - 1n : lastClosed
      if (newThrough > through) scanCache.setThrough(podStr, Number(newThrough))
    }
  }
  return out
}

/** Detect claimable VOTER (pod,epoch) on-chain. The pod set is the pods the wallet VOTED on
 *  (from the node's executed-vote activity — the wallet doesn't own them, so they're absent
 *  from the owner Transfer-log cache). For each (pod,epoch): NOT-yet-claimed
 *  (hasUserClaimedEmissions) AND a non-reverting claimVoterEmissions eth_call ⇒ claimable.
 *  The eth_call reverts when nothing is due for this voter at this (pod,epoch); we also gate on
 *  the wallet's recorded votes for the (pod,epoch) being > 0 (only-claim-if-earning) — see below.
 *
 *  COST CONTROL + earning gate — the (pod × epoch) eth_call grid is bounded so a first run doesn't
 *  storm the public RPC, and claims are only attempted where the wallet actually earns:
 *   1. `floorEpoch` — never scan below the epoch the node first existed (default 1).
 *   2. ACTIVE-epoch gate — a voter only earns at an epoch it voted in, so compute
 *      votesCastedByVoterForEpoch(wallet, ep) ONCE per epoch in [floor, lastClosed] and check
 *      pods only at epochs where it is > 0. Collapses ~(pods × allEpochs) to (pods × activeEpochs).
 *   3. PER-POD vote gate — getVotersUp/DownVotesForPodInEpoch(ep, pod, wallet) > 0. The reward is
 *      the voter's share of the pod's pool, so no recorded votes ⇒ 0 payout. With votes now cast
 *      at real 18-decimal weight, votes > 0 ⟹ a real share ⟹ > 0 emissions, so this skips
 *      0-REPPO claim txs (wasted gas) and is lossless (a reward requires votes at that pod,epoch).
 *
 *  `cache` makes the scan incremental: the watermark resumes past already-scanned epochs.
 *  Amount is unknown pre-claim (0); the chain pays what's owed. */
export async function queryVoterClaimableOnchain(
  rpcUrl: string, wallet: string, votedPodIds: string[], cache?: VoterScanCache, deps: RpcDeps = {},
): Promise<ClaimableEmission[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const pm = deps.podManager ?? networkAddresses().podManager
  const ve = deps.veReppo ?? networkAddresses().veReppo
  const floor = BigInt(deps.floorEpoch ?? 1)
  if (votedPodIds.length === 0) return []

  const cur = BigInt(await ethCall(fetchImpl, rpcUrl, ve, SEL.currentEpoch))
  if (cur <= 1n) return [] // no closed epochs yet
  const w = addrWord(wallet)
  const out: ClaimableEmission[] = []
  const lastClosed = cur - 1n
  const scanFrom = floor > 1n ? floor : 1n
  const useMc = await isMulticallAvailable(rpcUrl, { fetchImpl })

  // Active closed epochs the wallet voted in (votesCasted > 0) — computed ONCE, shared by all
  // pods. A pod can only have a voter reward at an epoch the wallet voted, so this prunes the
  // grid without dropping any real claim.
  const activeEpochs: bigint[] = []
  if (useMc && lastClosed >= scanFrom) {
    const eps: bigint[] = []
    for (let ep = scanFrom; ep <= lastClosed; ep++) eps.push(ep)
    const res = await tryAggregate(rpcUrl, eps.map((ep) =>
      ({ target: pm, callData: SEL.votesCasted + w + word(ep) })), { fetchImpl })
    // Mirrors the serial `.catch(() => '0x')`: an inner failure reads as "not active".
    eps.forEach((ep, i) => { if (res[i].success && isTrue(res[i].returnData)) activeEpochs.push(ep) })
  } else {
    for (let ep = scanFrom; ep <= lastClosed; ep++) {
      // Same fail-open rule as readUint: only a contract REVERT reads as "not active".
      // A transient failure must propagate — swallowing it dropped the epoch from
      // activeEpochs, so every pod's claim at that epoch was skipped while the watermark
      // still advanced past it (a permanently lost voter claim from one RPC blip).
      const cast = await ethCall(fetchImpl, rpcUrl, pm, SEL.votesCasted + w + word(ep))
        .catch((e: unknown) => { if (e instanceof RpcRevertError) return '0x'; throw e })
      if (isTrue(cast)) activeEpochs.push(ep)
    }
  }
  if (activeEpochs.length === 0) return []

  const podList = [...new Set(votedPodIds)]
  const throughFor = (podStr: string): bigint => (cache ? BigInt(cache.getThrough(podStr)) : 0n)

  // Batched GATE reads (voterUp, voterDown, hasUserClaimedEmissions — all plain views keyed
  // by explicit args, no msg.sender): 3 calls per unscanned (pod, epoch) pair collapse into
  // ⌈3·pairs/200⌉ requests. The claim PROBE below stays serial — its revert oracle needs
  // `from: wallet` (see multicall.ts header).
  let gateByPair: Map<string, { up: bigint; down: bigint; claimed: boolean }> | null = null
  if (useMc) {
    const pairs = podList.flatMap((podStr) =>
      activeEpochs.filter((ep) => ep > throughFor(podStr)).map((ep) => ({ pod: podStr, ep })))
    gateByPair = new Map()
    if (pairs.length > 0) {
      const calls = pairs.flatMap(({ pod, ep }) => {
        const pid = word(BigInt(pod))
        return [
          { target: pm, callData: SEL.voterUp + word(ep) + pid + w },
          { target: pm, callData: SEL.voterDown + word(ep) + pid + w },
          { target: pm, callData: SEL.hasVoterClaimed + word(ep) + pid + w },
        ]
      })
      const res = await tryAggregate(rpcUrl, calls, { fetchImpl })
      // voterUp/Down mirror readUint (failure → 0n); hasUserClaimedEmissions mirrors the
      // serial ethCall (a revert on a no-revert-path view aborts the scan before any
      // watermark advances, like a serial transient failure).
      const uintOr0 = (r: Call3Result): bigint => (r.success && r.returnData !== '0x' ? BigInt(r.returnData) : 0n)
      pairs.forEach(({ pod, ep }, i) => {
        const claimed = res[3 * i + 2]
        if (!claimed.success) throw new Error('RPC eth_call error: hasUserClaimedEmissions reverted in multicall')
        gateByPair!.set(`${pod}|${ep}`, {
          up: uintOr0(res[3 * i]), down: uintOr0(res[3 * i + 1]), claimed: isTrue(claimed.returnData),
        })
      })
    }
  }

  for (const podStr of podList) {
    const podId = BigInt(podStr)
    // Resume past the watermark (highest closed epoch already scanned); first run → from floor.
    const through = throughFor(podStr)
    let firstClaimable: bigint | null = null
    for (const ep of activeEpochs) {
      if (ep <= through) continue
      // GATE: the wallet must have CAST votes on THIS pod in THIS epoch to earn voter emissions.
      // Now that votes carry real 18-decimal weight, votes > 0 ⟹ a real curation share ⟹ > 0
      // payout — so skipping vote==0 (pod,epoch) avoids 0-REPPO claim txs (wasted gas) without
      // dropping any real claim (a reward requires the wallet voted there). hasUserClaimed/claim
      // checks only run for pods the wallet actually voted.
      const gate = gateByPair?.get(`${podStr}|${ep}`)
      const up = gate ? gate.up : await readUint(fetchImpl, rpcUrl, pm, SEL.voterUp + word(ep) + word(podId) + w)
      const down = gate ? gate.down : await readUint(fetchImpl, rpcUrl, pm, SEL.voterDown + word(ep) + word(podId) + w)
      if (up === 0n && down === 0n) continue
      // hasUserClaimedEmissions(epoch, podId, user)
      const claimed = gate
        ? gate.claimed
        : isTrue(await ethCall(fetchImpl, rpcUrl, pm, SEL.hasVoterClaimed + word(ep) + word(podId) + w))
      if (claimed) continue
      try {
        // claimVoterEmissions(voter, podId, epoch) — reverts ⇒ nothing due for this voter
        await ethCall(fetchImpl, rpcUrl, pm, SEL.claimVoter + w + word(podId) + word(ep), wallet)
      } catch (e) {
        if (e instanceof RpcRevertError) continue // reverts ⇒ nothing due for this voter
        throw e // transient RPC failure: abort before the watermark advances, so this epoch stays re-checkable next cycle
      }
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
