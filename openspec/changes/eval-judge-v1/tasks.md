# Tasks: eval-judge-v1

## 1. Gateway repo scaffold

- [x] 1.1 Create fresh repo `eval-api` (local `~/code/eval-api`, GitHub `Reppo-Labs/eval-api` — push only when told): Node 22 ESM TypeScript, vitest, tsc strict, CI (typecheck → test → build), following orquestra conventions (`.js` import extensions, colocated `*.test.ts`)
- [x] 1.2 CDK app skeleton mirroring `collector/cdk/stack.ts` conventions: one stack, NodejsFunction ESM bundling, bounded log retention
- [x] 1.3 Config module: v1 datanet id, quorum target/settlement deadline, rate limits, budget caps — env/SSM-overridable, zod-validated

## 2. Infrastructure (CDK)

- [x] 2.1 DynamoDB single-table (jobs, leases, node answers, results with TTL, mint ledger, rate-limit buckets) + S3 embeddings bucket (RETAIN both; corpus/ lifecycle 7d)
- [x] 2.2 SQS FIFO mint queue + DLQ (maxReceiveCount 5); CloudWatch alarms on DLQ depth + MintBudgetCapHit + UnservedJobs custom metrics
- [x] 2.3 API GW HTTP API + intake/read/node-API Lambdas wired (handlers stubbed 501 pending tasks 3–5); EventBridge hourly sync rule + 15-min settlement sweep (handler settles jobs whose epoch end + 1h cut-off passed — no per-job timers)
- [x] 2.4 Secrets Manager secret `eval-api/wallet-key` referenced by name + grantRead to mint Lambda only; manual creation documented in README

## 3. Intake path (eval-api spec)

- [x] 3.1 Request schema validation: 400 with reasons, 32 KB cap, criteria bounds, type enum (unit tests)
- [x] 3.2 Caller auth + free-tier controls: platform API key required via x-api-key (401 unkeyed; cryptographic validation pending the 4.1 probe — key trusted as bucketing identity, global cap bounds fabricated-key abuse); per-key token bucket (10/h burst 3) AND per-key mint allowance (10/day, global 100/day with rollback on global refusal) checked at intake → 429 with retry-after/quota-reset; idempotency-key → same evalId, limits charged once (unit tests)
- [x] 3.3 202 response {evalId}; job record with epoch assignment (config-mirrored schedule EPOCH_GENESIS_ISO + EPOCH_DURATION_SECONDS, 3h-tail rollover, cut-off epoch end + 1h) + pinned latest corpus version (503 CORPUS_UNAVAILABLE when none, reservations released) + metadata-pod FIFO mint message (payloadHash, never the payload)
- [x] 3.4 Read Lambda: GET /v1/evals/{id} (pending|settled|failed with reason, result when settled)

## 4. Job distribution (job-distribution spec)

- [x] 4.1 Node auth middleware: agentId + apiKey validated against the LIVE agents API — probed 2026-08-27: `GET /api/v1/agents/:id/pods` with Bearer key answers 401 "Invalid API key" on bad creds (GET /agents/:id is 405 PATCH-only). Cached per container (5 min positive / 30 s negative); platform 429/5xx/outage serves the stale verdict or 503 AUTH_UNAVAILABLE — never blames node creds for an outage (`src/node/auth.ts` + tests). Launch smoke (9.4) must confirm the 2xx side with real house-node creds. Caller-key validation at intake remains identity-only (this route needs an agentId; callers have none)
- [x] 4.2 Lease endpoint: per-(job,node) lease records via conditional put (multi-node concurrent serving, no same-node re-offer, race-safe), open until epoch end + 1h; slim payload with presigned version-addressed corpus URL (`src/node/service.ts` + tests; long-poll wait loop pending — returns 204 immediately for now)
- [x] 4.3 Complete/fail endpoints: idempotent answer recording per jobId+node (conditional put, duplicates succeed silently); timestamp-enforced cut-off rejection (409); citation resolution at submission → 422 discard + record against node (resolver fails closed until the 8.2 corpus manifests exist)
- [x] 4.4 Contract fixture suite for lease/ack — fixtures vendored in both repos: eval-api pins via CHECKSUMS.sha256 (CI `fixtures:check`) + runs them through its handlers (`src/node/contract.test.ts`); orquestra pins in-code checksums + runs them through the worker client (`test/integration/leaseAckContract.test.ts`); epoch fields + error-codes.json synced 2026-08-27

## 5. Settlement (eval-judging spec)

- [x] 5.1 Epoch settlement sweep: at epoch end + 1h aggregate ALL answers received (median per-criterion scores, merged critiques, citation union, agreement when ≥2); 1 answer = settle with quorum {served:1, agreement:null}; 0 answers = failed + unserved metric — pure logic in `src/settle/settle.ts` + `epoch.ts` (sweep trigger wiring lands with 2.3)
- [x] 5.2 Result assembly (design 2c): 0–100 overall score (mean of medians ×10) + decision thresholds (≥70/40–69/<40), confidence {agreement formula, dispersion buckets}, action.route (auto-ship/review/block; never auto-ship at served=1), dissent via decision-flip rule, evidence block, quorum block, provenance (per-answer model + anonymized node ids, requestPodId, receipt = mint tx, settledAt)
- [x] 5.3 Settlement unit tests: 3-answer, 1-answer, 0-answer scenarios + fabricated-citation discard + late-answer-after-cut-off rejection + dissent flip/no-flip + rollover epoch assignment (`settle.test.ts`, `epoch.test.ts`)
- [x] 5.4 OBSOLETE (2026-08-26): verdict stays gateway-only — no post-settlement platform update (no new platform endpoints; #10 closed)

## 6. Orquestra evalworker (job-distribution spec, orquestra repo)

- [x] 6.1 `evalWork` config block in StrategyConfig schema ({enabled, maxConcurrent}), hot-reload wiring, off by default
- [x] 6.2 `src/evalworker/` loop beside the scheduler: long-poll lease → fetch corpus (presigned URL) → top-k cosine → judge call (temp 0, rubric prompt, INJECTION_GUARD, date line, model id reported) → submit result; failures isolated from vote/mint
- [x] 6.3 Eval LLM budget ledger line: stop leasing when spent, resume next window (unit tests)
- [x] 6.4 Dashboard: eval activity rows on existing activity rails
- [x] 6.5 Run the shared lease/ack contract fixture suite against the worker in orquestra CI
- [x] 6.6 Port Phase 0 probe set (incl. injection probes) as judge regression tests
- [x] 6.7 Revision pass for the epoch model (REDUCED 2026-08-26: inline request stays): lease fields `epoch`/`answerCutoff`/`corpusVersion` replace `leaseExpiresAt`/`settlementDeadline`; updated contract fixtures + checksum guard

## 7. Mint worker (pod-minting spec)

- [x] 7.0 RESOLVED (2026-08-26): no new platform capabilities — metadata pod via current API, gateway serves everything an eval needs (#10 closed)
- [x] 7.1 Wallet module: viem on Base (PodManager V2 `mintPodWithREPPO(to, subnetId)` per reppo-cli ABI), key from Secrets Manager, publishing-fee balance/allowance preflight, simulate-before-sign, tokenId from the Transfer-from-zero log (`src/mint/wallet.ts`) — NOTE: needs a one-time REPPO approve to the PodManager at launch (9.5)
- [x] 7.2 Budget ledger: DynamoDB conditional-update caps (`incrementMintCount`) — per-key 10/day + global 100/day charged at intake BEFORE any message reaches the signer (refuse-before-signing), floored rollback, `MintBudgetCapHit` metric emitted on global refusal + `WalletReppoBalance` gauge from the consumer preflight, alarm wired (unit tests)
- [x] 7.3 FIFO consumer: reserved concurrency 1, stuck-tx timeout + same-nonce gas-bump rebroadcast (+25%, max 2), SQS redelivery ×5 → DLQ alarm; recordMint conditional on receipt='pending' (redelivery never re-signs), unknown-job messages dropped (`src/mint/consumer.ts` + tests)
- [x] 7.4 Failure-isolation test: receipt-pending job settles with `provenance.receipt: "pending"` (sweep test); mint failure propagates to SQS retry without touching the job

## 8. Sync worker (datanet-sync spec)

- [x] 8.1 Pull the v1 datanet's pod content (reppo.ai `GET /public/pods`, unauthenticated; tolerant field mapping — rows without usable text skipped, never guessed; Base RPC not needed for the text corpus)
- [x] 8.2 Write version-addressed TEXT corpus objects (`corpus/<datanetId>/<version>.json` + latest pointer, temp-key + atomic copy, pointer-last commit, last-good wins) with per-version pod-id manifests (no embeddings in v1 — see amended design decision 3); lifecycle-expire superseded versions (7d, CDK)
- [x] 8.3 Presigned version-addressed corpus URLs in lease payloads; job records carry the corpus version, and node/settle handlers resolve citations against that version's manifest (per-container cached; manifest-unavailable throws instead of silently discarding)

## 9. Launch prerequisites

- [ ] 9.1 Create (or designate) the v1 datanet on Base (minimal fees); record id + epoch duration in config (verify epoch on-chain; 48h SLA math assumes epoch ≤ ~46h)
- [ ] 9.2 Enable evalwork on 1–2 Reppo house nodes (incl. Major Oak candidate) so min-1 quorum is always reachable
- [ ] 9.3 API docs page: contract, platform-API-key signup, per-key limits (10/h, 10 mints/day), 48h-after-epoch-end SLA + 3h rollover rule, result-shape reference (0–100, decision/route thresholds), per-criteria threshold guidance, publicity disclosure — request TYPE + CRITERIA (and payload hash) become public pod metadata, votable by humans; payloads stay private (gates announcement)
- [ ] 9.4 Deploy to chosen account/region; smoke: 400 invalid, 429 over-limit, 202→settled round-trip through a real node, pod visible on datanet
- [ ] 9.5 Fund wallet float; publish docs + announce
- [ ] 9.6 Ops runbook: wallet top-up, DLQ redrive, unserved-jobs alarm response, intake kill switch

## 10. Measurement (kill/build criteria)

- [ ] 10.1 Metrics: total evals, distinct external users (per API key), repeat users, quorum served distribution (0/1/2), evidenceBasis split (citations vs model-judgment), request-pod topic clusters, per-request subsidy cost, outcome-vs-verdict logging (calibration data so `action.est_error` can exist in v2)
- [ ] 10.2 30-day review doc wired to the criteria: <10 distinct external users or zero repeat → stop; else propose next change (monetization and/or quorum target raise + ACP evaluator lane)
