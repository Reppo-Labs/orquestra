## 1. Contract fixtures
- [x] 1.1 Copy eval-api `fixtures/lease-ack/{lease-response,complete-request,deny-request,error-codes,fail-request}.json` at `ad217dd` into `test/fixtures/lease-ack/`; delete `corpus-snapshot.json`
- [x] 1.2 Re-pin `CHECKSUMS` in `test/integration/leaseAckContract.test.ts` from eval-api `CHECKSUMS.sha256`; remove corpus tests; add deny round-trip and old-shape-lease rejection tests

## 2. Types and client
- [x] 2.1 `types.ts`: `Citation { datanetId, podId }`; `CriterionVerdict.citations: Citation[]`; `EvalAnswer` without `evidenceBasis`; `LeasedJob` without corpus fields; `DatanetPod`; `EvalDenial { jobId, reason, datanetsSearched }`; remove `CorpusPod`/`CorpusSnapshot`
- [x] 2.2 `client.ts`: strict lease schema; remove `fetchCorpus`; add `deny()`; complete body = new shape; tests

## 3. Datanet source
- [x] 3.1 `datanet.ts`: `DatanetSource` port, `DatanetPod`, `InMemoryDatanetSource`, `cachedSource(source, ttlMs)`
- [x] 3.2 `datanetClient.ts`: provisional HTTP binding (Bearer node key, base override env), throws on any failure; tests with injected fetch
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
