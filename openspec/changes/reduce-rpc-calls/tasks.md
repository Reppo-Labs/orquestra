# Tasks: reduce-rpc-calls

## 1. Multicall batching (independent of cache; ship first)

- [x] 1.1 Create `src/reppo/multicall.ts`: `aggregate3` encode/decode, batch-size chunking (200), `isMulticallAvailable(rpcUrl)` via one cached `eth_getCode` probe; unit tests with fixture RPC responses (mixed success/revert, chunk split, no-code fallback)
- [x] 1.2 Add multicall path to `src/reppo/epochVotes.ts` (2×N calls → batches), reusing the existing per-call decode; test asserts batched result identical to serial on same fixtures
- [x] 1.3 Add multicall path to `src/reppo/subnetPools.ts` (2 calls → 1 batch, folds into other grids where callers allow)
- [x] 1.4 Add multicall path to the view-getter reads in `src/reppo/emissionsOnchain.ts` (`hasClaimed`, `hasVoterClaimed`, `votesCasted`, `voterUp/Down`); claim probes (`from: wallet`, msg.sender-dependent) stay serial; test mixed batch classifies each (pod, epoch) identically to serial
- [x] 1.5 One-off: check Multicall3 code presence on Robinhood 4663 and Base 8453 (`cast code 0xcA11bde05977b3631167028862bE2a173976CA11 --rpc-url ...`); record result in design.md Open Questions — VERIFIED 2026-07-31: deployed on both

## 2. Read cache

- [x] 2.1 Create `src/reppo/readCache.ts`: `makeCachedReader(inner, policy)` decorator with tick-scoped memo, TTL, epoch-derived expiry classes, tag-keyed entries, `beginCycle()`, `invalidateTags()`, fall-through to inner reader on internal error; unit tests per freshness class
- [x] 2.2 Wire cached reader in `src/runtime/wiring.ts`; call `beginCycle()` from the scheduler tick entry; verify the duplicate `listPods` calls (`wiring.ts:332,339,402`) and `listDatanets` calls (252, 598) hit the memo (assert one underlying call in wiring tests)
- [x] 2.3 Add `onWriteExecuted(kind)` callback to `src/wallet/executor.ts` (fires only on `executed` status; no budget/signing changes); wire tag mapping (vote→votes+balance, mint→pods+balance, claim→emissions+balance, grant→balance); tests for invalidation on each write kind and for no-invalidation on refused/failed writes
- [x] 2.4 Route dashboard `/api/datanets` through the shared cached reader and delete `netNamesCache` in `src/dashboard/routes.ts`; keep the stale-tolerant degrade behavior (serve last-known names on read failure)

## 3. Verification

- [x] 3.1 Full suite green: `npm test`, `npm run typecheck`
- [x] 3.2 Cycle-level assertion test: a simulated cycle over a datanet with N pods issues O(batches) RPC requests, not O(N) (count calls via injected fetch/exec fakes) — `src/runtime/rpcBudget.test.ts`: 200 pods → 6 eth_calls (vs 400 unbatched)
- [ ] 3.3 Run one live cycle on the Base node (`docker` rebuild + run-now), confirm identical vote/mint decisions and log the request-count drop
