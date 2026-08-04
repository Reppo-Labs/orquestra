# Proposal: reduce-rpc-calls

## Why

Orquestra assumes operators run against free/public RPC endpoints (e.g. `mainnet.base.org`, `rpc.mainnet.chain.robinhood.com`) — paid RPC must never be a requirement to run a node. Today a single cycle issues an unbounded per-pod eth_call grid (`epochVotes.ts`: 2 calls × every pod on a datanet) plus duplicate CLI shell-outs (`listPods` up to 3× per datanet, `listDatanets` at 2+ call sites), which bursts past free-tier rate limits as datanets grow and makes cycles fail or crawl on public endpoints.

## What Changes

- Add a read cache at the `ReppoReader` seam (`src/reppo/reader.ts`) with per-method freshness policy: tick-scoped memoization for reads that must be fresh per cycle (balance, voting power, pods), TTL for slow-moving data (datanet list), and epoch-derived expiry for epoch info (`secondsRemaining` is the natural TTL).
- Deduplicate within-cycle repeat reads: the second/third `listPods` and `listDatanets` calls in a cycle hit the memo, not the CLI/RPC.
- Batch eth_call grids through Multicall3 (`aggregate3`, `allowFailure: true` so revert-semantics reads like claimable checks keep per-call outcomes): `epochVotes` (2×N → ⌈N/batchSize⌉ calls), owner/voter claimable scans, `subnetPools`. Probe Multicall3 code presence once per chain and fall back to today's serial calls when absent.
- Invalidate on writes: `WalletExecutor` write paths (vote, mint, claim) evict the reads they stale (epoch vote volume, own pods, emissions due). Caching never changes what the node decides — only how often it re-reads unchanged state.

Not in scope: caching CLI *internals* (the `reppo` CLI is a black box; caching wraps whole shell-outs), persistent cross-restart caching beyond the existing scan watermarks, and any change to write/signing paths.

## Capabilities

### New Capabilities
- `rpc-read-cache`: freshness-policied caching and within-cycle deduplication of all reads behind the `ReppoReader` seam, with write-triggered invalidation.
- `rpc-call-batching`: Multicall3 aggregation of per-pod/per-epoch eth_call grids with per-chain availability probing and serial fallback.

### Modified Capabilities

(none — existing behavior is unspecified in `openspec/specs/`; both capabilities are new specs)

## Impact

- `src/reppo/reader.ts` — cache decorator wraps the read facade (single seam; consumers unchanged).
- `src/reppo/epochVotes.ts`, `emissionsOnchain.ts`, `subnetPools.ts` — gain a multicall path.
- `src/runtime/wiring.ts` — constructs the cached reader; passes write-invalidation hooks to `WalletExecutor` wiring.
- `src/wallet/executor.ts` — emits invalidation events after executed writes (no budget/signing logic touched).
- New: `src/reppo/multicall.ts`, `src/reppo/readCache.ts` (+ colocated tests).
- No config schema change required; cache TTLs are code constants (revisit if operators need tuning).
- Risk to watch: stale reads must never cause double-spend or double-vote decisions — dedup (`deps.dedup`) already guards vote/mint idempotency, and budget checks read the ledger (not RPC), so caps are unaffected.
