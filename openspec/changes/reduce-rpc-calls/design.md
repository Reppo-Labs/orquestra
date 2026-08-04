# Design: reduce-rpc-calls

## Context

See `proposal.md` — Why. Relevant current state:

- `src/reppo/reader.ts` is the single read facade (`ReppoReader`) over both channels: `reppo` CLI shell-outs and direct JSON-RPC. All runtime consumers import from it; the query files behind it are private.
- Per-cycle call profile today: `epochVotes.ts` does 2 eth_calls per distinct pod ("2 eth_calls per distinct pod" is documented in-file); `emissionsOnchain.ts` probes a (pod × epoch) eth_call grid bounded by DB watermarks; `listPods` runs up to 3× per datanet per cycle (`wiring.ts:332,339,402`); `listDatanets` runs at 2+ call sites plus the dashboard.
- Existing caches to respect, not duplicate: rubric process cache (`src/rubric/load.ts`), scan watermarks (`podCacheStore.ts` → activity.db), single shared epoch read per tick (`wiring.ts:570`), dashboard datanet-name TTL cache (`routes.ts:162`).
- Writes all flow through `WalletExecutor` (`src/wallet/executor.ts`), which is the natural invalidation point.

## Goals / Non-Goals

**Goals**

- One place to reason about read freshness: every policy lives in the cache decorator, not scattered at call sites.
- Grid reads scale as O(batches), not O(pods).
- Zero behavior change when multicall is absent or the cache is bypassed.

**Non-Goals**

- No persistent (cross-restart) caching beyond the existing watermarks — restart cost is one cycle's worth of reads, acceptable.
- No change to the rubric cache or scan watermarks; they already work.
- No operator-facing cache configuration in this change (constants first; expose knobs only if real deployments need tuning).
- No attempt to reduce calls *inside* a single `reppo` CLI invocation (black box).

## Decisions

### D1: Cache as a decorator on `ReppoReader`

`makeCachedReader(inner: ReppoReader, policy): ReppoReader` in a new `src/reppo/readCache.ts`. Wiring constructs it around the existing reader; every consumer (cycle, snapshot, dashboard, discovery) gets caching for free with no signature changes.

- *Alternative — per-call-site caches (like `netNamesCache`)*: rejected; that pattern already produced two independent datanet-list caches with different policies. The dashboard's `netNamesCache` gets retired in favor of the shared reader.
- *Alternative — caching inside each query file*: rejected; policies would be invisible at the seam and untestable as a unit.

### D2: Three freshness classes, tag-keyed entries

| Class | Applies to | Expiry |
|---|---|---|
| tick-scoped memo | listPods, datanetPodVotes, balance, votingPower, emissionsDue, votePowerBudget | cleared by `beginCycle()` called from the scheduler tick |
| TTL | listDatanets (10 min, matching the existing dashboard cache) | wall clock |
| epoch-derived | epoch() | `min(secondsRemaining, MAX)` with a small floor to tolerate clock skew |

Every entry carries invalidation tags (`pods`, `votes`, `emissions`, `balance`). `beginCycle()` is explicit rather than inferred from time so tests control it deterministically.

- *Alternative — one global TTL*: rejected; a TTL long enough to help crosses cycle boundaries and serves stale pod lists to voting.

### D3: Write-triggered invalidation via executor callback

`WalletExecutor` gains an optional `onWriteExecuted(kind: 'vote'|'mint'|'claim'|'grant')` callback, wired to `cache.invalidateTags(...)`. Mapping: vote → `votes`,`balance`; mint → `pods`,`balance`; claim → `emissions`,`balance`; grant → `balance`. Executor stays ignorant of the cache; budget/signing logic untouched.

- *Alternative — invalidate everything after any write*: simpler, considered acceptable fallback; rejected to keep the epoch/datanet TTL entries (which writes cannot change) warm.

### D4: Multicall3 `aggregate3` for grids, availability probed once

New `src/reppo/multicall.ts`: `tryAggregate(rpcUrl, calls[]) → { success, returnData }[]` using the canonical Multicall3 address (`0xcA11bde05977b3631167028862bE2a173976CA11`, deployed on most EVM chains) with `allowFailure: true`, batch size 200 calls per request. Availability = one `eth_getCode` per process per chain, cached in-process; empty code → callers use their existing serial paths unchanged. `epochVotes.ts`, `subnetPools.ts`, and the *view-getter* reads in `emissionsOnchain.ts` (`hasClaimed`, `hasVoterClaimed`, `votesCasted`, `voterUp/Down`) gain a multicall path that decodes each `returnData` with the exact same per-call decode used serially; `success: false` maps to the serial path's revert semantics.

**Scope constraint (discovered during apply): claim probes cannot batch.** The owner/voter claim probes (`claimPodOwnerEmissions`, `claimVoterEmissions`) are eth_calls with `from: wallet` — their revert/no-revert oracle depends on `msg.sender`. Routed through Multicall3, `msg.sender` becomes the Multicall3 contract, every probe reverts, and "revert ⇒ nothing due" would misclassify claimable epochs and advance the scan watermark past them (permanent loss). Claim probes therefore stay serial with `from: wallet`, unchanged. The batching win in the scans comes from the gate reads that precede the probes — the probe itself only runs for the small subset that passes the gates.

- *Alternative — JSON-RPC batch arrays*: rejected; many free endpoints cap or disable batch requests, and providers commonly count each batched item against the rate limit anyway. Multicall3 is one real request.
- *Alternative — hardcode per-chain availability*: rejected; Robinhood Chain (4663) status is unverified, and probe+fallback also covers future networks.

## Risks / Trade-offs

- [Stale read informs a decision] → dedup records and the budget ledger remain authoritative (spec: rpc-read-cache / "never changes decisions unsafely"); caching only wraps reads, never write gating.
- [Multicall decode drift vs serial path] → the multicall path reuses the same decode functions as the serial path; tests assert serial and batched results are identical on the same fixture data.
- [Oversized batch rejected by a strict RPC] → batch size constant (200) is far below typical eth_call gas caps; a failed batch surfaces as a read failure handled by existing per-datanet isolation (no silent partial results).
- [Epoch expiry vs clock skew] → floor the epoch TTL (e.g. 30 s) so a skewed `secondsRemaining` cannot pin a stale epoch forever.
- [Cache bug worse than no cache] → decorator has a kill switch (construct wiring with the raw reader) and falls through to the inner reader on internal error.

## Migration Plan

No config or schema changes; no persisted state added. Deploy = normal image rebuild; both nodes pick it up transparently. Rollback = revert the wiring line that wraps the reader (raw reader restores today's behavior exactly).

## Open Questions

- ~~Is Multicall3 deployed on Robinhood Chain (4663)?~~ RESOLVED 2026-07-31: `cast code 0xcA11bde05977b3631167028862bE2a173976CA11` returns bytecode on BOTH Base 8453 and Robinhood 4663 — both nodes exercise the batched path; serial fallback covers future chains only.
- Should the dashboard's `/api/datanets` handler drop its private `netNamesCache` in this change or a follow-up? Default: this change (it's a deletion), but it can ship without.
