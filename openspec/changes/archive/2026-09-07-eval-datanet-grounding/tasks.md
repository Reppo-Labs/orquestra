## 1. Contract fixtures
- [x] 1.1 Copy eval-api `fixtures/lease-ack/{lease-response,complete-request,deny-request,error-codes,fail-request}.json` at `ad217dd` into `test/fixtures/lease-ack/`; delete `corpus-snapshot.json`
- [x] 1.2 Re-pin `CHECKSUMS` in `test/integration/leaseAckContract.test.ts` from eval-api `CHECKSUMS.sha256`; remove corpus tests; add deny round-trip and old-shape-lease rejection tests

## 2. Types and client
- [x] 2.1 `types.ts`: `Citation { datanetId, podId }`; `CriterionVerdict.citations: Citation[]`; `EvalAnswer` without `evidenceBasis`; `LeasedJob` without corpus fields; `DatanetPod`; `EvalDenial { jobId, reason, datanetsSearched }`; remove `CorpusPod`/`CorpusSnapshot`
- [x] 2.2 `client.ts`: strict lease schema; remove `fetchCorpus`; add `deny()`; complete body = new shape; tests

## 3. Datanet source
- [x] 3.1 `datanet.ts`: `DatanetSource` port, `DatanetPod`, `InMemoryDatanetSource`, `cachedSource(source, ttlMs)`
- [x] 3.2 `datanetClient.ts`: HTTP binding (base override env), throws on any failure; tests with injected fetch
- [x] 3.3 `retrieve.ts`: `RankedPod.pod` is a `DatanetPod`; `gatherEvidence(source, request, k)` = fetch all accessible → rank; tests

## 4. Relevance gate
- [x] 4.1 `gate.ts`: `gateEvidence(model, request, candidates) → { supported: Map<criterion, DatanetPod[]>, unsupported: string[], datanetsSearched: number[] }`; schema post-checks; zero candidates short-circuits without an LLM call; tests with a mocked generator + direct schema tests

## 5. Judge
- [x] 5.1 `judge.ts`: prompt lists gated pods per criterion, citations mandatory; post-check strips ungated keys, maps to `Citation`, throws on an uncited criterion; `JudgeOutcome` without `evidenceBasis`; update tests

## 6. Worker
- [x] 6.1 `worker.ts`: deps gain `datanet: DatanetSource`, `gate`; serve() per design D5; deny path with terminal-4xx rule; `EvalActivityRow.status` adds `'denied'`; update tests (deny path, gate/judge errors → :fail, datanet source error → :fail, budget before retrieval)
- [x] 6.2 `src/index.ts`: bind `datanetClient` with `REPPO_API_KEY` + `EVAL_DATANET_API_URL ?? platformBase()`; bind gate with the default model

## 7. Docs and verification
- [x] 7.1 Update any docs/onboarding text mentioning `model-judgment`, corpus snapshot, or `corpusUrl` (grep)
- [x] 7.2 `npm run typecheck`, `npm test`, full grep for `corpus|evidenceBasis|model-judgment` with every hit justified
- [ ] 7.3 PR against `main`; body states deploy order (nodes before gateway) and links eval-api #15 / openspec datanet-grounded-judging

## 8. Stage 2 review fixes (PR #214)
- [x] 8.1 H1 `buildDenyReason`: index + bounded excerpt + hard clamp to the gateway's 2000-char `reason` cap; spec pins the cap
- [x] 8.2 M1 `EvalBudget.release()`; worker releases on every pre-LLM failure (source throw, no accessible datanets, zero-candidate deny)
- [x] 8.3 M2 `DatanetError(status)`; 401/403 gets the credential message and a 10x lease backoff
- [x] 8.4 L2 `gatherEvidence` = allSettled; `datanetsSearched` names only the datanets read; total failure rethrows
- [x] 8.5 L3 `DatanetSource.invalidate()` on `cachedSource`, called on a 422 UNRESOLVABLE_CITATION
- [x] 8.6 L5 gate dedups on the normalized pod key
- [x] 8.7 L6 probes carry per-probe gated evidence so the live run works again
- [x] 8.8 L1/L4/L7/I1/I2 doc + comment corrections; `GateResult.datanetsSearched` (dead) removed

## 9. Stage 2b review fixes (PR #214)
- [x] 9.1 A `gatherEvidence` returns `unreadable`; the worker :fails (never denies) on unsupported criteria while any datanet was unreadable; the two now-false in-source invariant comments corrected
- [x] 9.2 B design.md D1 drops the false "mirrors eval-api's `client.ts`" claim (matches the corrected `datanetClient.ts` header); D2 documents the partial-read/`unreadable` behaviour

## 10. Real datanet API binding (follow-up to PR #214; lands with eval-api PR #16)
The provisional guess in `datanetClient.ts` was wrong. The API was probed live on 2026-09-04; see design D1 for the endpoints, envelopes and the cuid decision.
- [x] 10.1 `types.ts`: `Citation.datanetId`, `DatanetPod.datanetId` and `EvalDenial.datanetsSearched` become subnet-cuid strings; doc comments say so
- [x] 10.2 `datanetClient.ts`: rewritten against `GET /public/subnets` and `GET /public/pods?filters[subnet]=<cuid>`; `apiKey` option dropped (the API is public); envelopes read strictly at `data.subnets` / `data.pods`; `limit` applied client-side; factual header replaces the PROVISIONAL one
- [x] 10.3 `datanet.ts` (port, `InMemoryDatanetSource`, `cachedSource` map key) keyed by string
- [x] 10.4 `retrieve.ts`: `datanetsSearched`/`unreadable` are `string[]`; partial-read behaviour unchanged (a partial outage still `:fail`s, never denies)
- [x] 10.5 `gate.ts`: `"datanetId/podId"` key scheme verified against cuids (no `/` in a cuid); trim/dedup fix re-verified by mutation
- [x] 10.6 `worker.ts`: deny payload `string[]`; `buildDenyReason` re-checked for the worst case now that ids are ~25 chars each — new test pins 26 cuids + 10 long criteria inside the 2000-char cap, with a non-vacuity check that the unclamped string overflows
- [x] 10.7 `src/index.ts` drops the datanet `apiKey` and says "public, no credential" in the startup log; `.env.example` says the datanet API needs none
- [x] 10.8 `test/fixtures/lease-ack/`: re-synced verbatim from eval-api `datanet-api-binding` @ 3d97995; checksums re-pinned
- [x] 10.9 `datanetClient.live.test.ts`: non-hermetic guard gated on `DATANET_LIVE`, run against the real API and mutation-verified (reading `data` instead of `data.pods` turns it red)
- [x] 10.10 design D1/D2 + both spec deltas record the endpoints, envelopes, the cuid decision and both reasons the numeric id was rejected
