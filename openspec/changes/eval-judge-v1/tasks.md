# Tasks: eval-judge-v1

## 1. Gateway repo scaffold

- [x] 1.1 Create fresh repo `eval-api` (local `~/code/eval-api`, GitHub `Reppo-Labs/eval-api` — push only when told): Node 22 ESM TypeScript, vitest, tsc strict, CI (typecheck → test → build), following orquestra conventions (`.js` import extensions, colocated `*.test.ts`)
- [ ] 1.2 CDK app skeleton mirroring `collector/cdk/stack.ts` conventions: one stack, NodejsFunction ESM bundling, bounded log retention
- [x] 1.3 Config module: v1 datanet id, quorum target/settlement deadline, rate limits, budget caps — env/SSM-overridable, zod-validated

## 2. Infrastructure (CDK)

- [ ] 2.1 DynamoDB single-table (jobs, leases, node answers, results with TTL, mint ledger, rate-limit buckets) + S3 embeddings bucket
- [ ] 2.2 SQS FIFO mint queue + DLQ, redrive policy; CloudWatch alarms on DLQ depth, wallet budget, unserved-jobs rate
- [ ] 2.3 API GW HTTP API + intake/read/node-API Lambdas wired; EventBridge hourly sync rule + per-job settlement-deadline scheduling
- [ ] 2.4 Secrets Manager secret (wallet key) + grantRead to mint Lambda only; document manual secret-creation step in README

## 3. Intake path (eval-api spec)

- [x] 3.1 Request schema validation: 400 with reasons, 32 KB cap, criteria bounds, type enum (unit tests)
- [ ] 3.2 Free-tier controls: per-caller token-bucket rate limit → 429 with retry-after; idempotency-key conditional put → same evalId on retry (unit tests)
- [ ] 3.3 202 response {evalId}; create job record + settlement deadline + mint message
- [ ] 3.4 Read Lambda: GET /v1/evals/{id} (pending|settled|failed)

## 4. Job distribution (job-distribution spec)

- [ ] 4.1 Node auth middleware: agentId + apiKey against platform (any authenticated node serves v1 jobs)
- [ ] 4.2 Lease endpoint: long-poll, per-(job,node) lease records (multi-node concurrent serving, no same-job re-offer to the same node), open until settlement deadline (two-nodes + crashed-node scenario tests)
- [ ] 4.3 Complete/fail endpoints: idempotent answer recording per jobId+node; citation resolution check at submission (unresolvable → discard + record against node)
- [ ] 4.4 Contract fixture suite for lease/ack — one set of fixtures, runnable against gateway handlers AND (later) the orquestra worker (shared package or copied fixtures with checksum guard)

## 5. Settlement (eval-judging spec)

- [ ] 5.1 Deadline settlement: EventBridge fires → aggregate ALL answers received (median per-criterion scores, merged critiques, citation union, agreement when ≥2); 1 answer = settle with quorum {served:1, agreement:null}; 0 answers = failed + unserved metric
- [ ] 5.2 Result assembly: overall decision, evidence block, quorum block, dissent (populated when an answer materially diverges), provenance (per-answer model + anonymized node ids, requestPodId, settledAt)
- [ ] 5.3 Settlement unit tests: 3-answer, 1-answer, 0-answer scenarios + fabricated-citation discard + late-answer-after-deadline rejection

## 6. Orquestra evalworker (job-distribution spec, orquestra repo)

- [x] 6.1 `evalWork` config block in StrategyConfig schema ({enabled, maxConcurrent}), hot-reload wiring, off by default
- [x] 6.2 `src/evalworker/` loop beside the scheduler: long-poll lease → fetch corpus (presigned URL) → top-k cosine → judge call (temp 0, rubric prompt, INJECTION_GUARD, date line, model id reported) → submit result; failures isolated from vote/mint
- [x] 6.3 Eval LLM budget ledger line: stop leasing when spent, resume next window (unit tests)
- [x] 6.4 Dashboard: eval activity rows on existing activity rails
- [x] 6.5 Run the shared lease/ack contract fixture suite against the worker in orquestra CI
- [x] 6.6 Port Phase 0 probe set (incl. injection probes) as judge regression tests

## 7. Mint worker (pod-minting spec)

- [ ] 7.1 Wallet module: viem client on Base, key from Secrets Manager, mint pod tx on the v1 datanet
- [ ] 7.2 Budget ledger: DynamoDB conditional-update cap, refuse-before-signing, alarm on cap hit (unit tests)
- [ ] 7.3 FIFO consumer: single concurrency, stuck-tx timeout + gas-bump rebroadcast, bounded retries → terminal alarm; requestPodId pending→confirmed update
- [ ] 7.4 Failure-isolation test: mint outage while evals settle (RPC-down scenario)

## 8. Sync worker (datanet-sync spec)

- [ ] 8.1 Pull the v1 datanet's pod content (Base RPC + reppo.ai API)
- [ ] 8.2 Embed + write S3 corpus object via temp-key + atomic copy (last-good wins on failure); newly minted request pods included next run
- [ ] 8.3 Presigned corpus URLs in lease payloads

## 9. Launch prerequisites

- [ ] 9.1 Create (or designate) the v1 datanet on Base (minimal fees); record id in config
- [ ] 9.2 Enable evalwork on 1–2 Reppo house nodes (incl. Major Oak candidate) so min-1 quorum is always reachable
- [ ] 9.3 API docs page: contract, free-tier limits, minutes-scale SLA, per-criteria threshold guidance, PROMINENT payload-publicity disclosure (gates announcement)
- [ ] 9.4 Deploy to chosen account/region; smoke: 400 invalid, 429 over-limit, 202→settled round-trip through a real node, pod visible on datanet
- [ ] 9.5 Fund wallet float; publish docs + announce
- [ ] 9.6 Ops runbook: wallet top-up, DLQ redrive, unserved-jobs alarm response, intake kill switch

## 10. Measurement (kill/build criteria)

- [ ] 10.1 Metrics: total evals, distinct external users, repeat users, quorum served distribution (0/1/2), evidenceBasis split (citations vs model-judgment), request-pod topic clusters, per-request subsidy cost
- [ ] 10.2 30-day review doc wired to the criteria: <10 distinct external users or zero repeat → stop; else propose next change (monetization and/or quorum target raise + ACP evaluator lane)
