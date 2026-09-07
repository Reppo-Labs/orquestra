# Proposal: eval-judge-v1

> **SUPERSEDED (2026-09-03)** by `openspec/changes/eval-datanet-grounding` — no pod is minted, nodes ground in datanets they can read or deny; see eval-api PR #15.

## Why

Reppo has decided to ship an evals-as-a-service API: agents submit their output to be scored by judges grounded in Reppo datanets. **v1 is free** and **evals are served by orquestra nodes** (each node runs its own LLM judge; a job settles with at least 1 node answering, target 2+).

## What Changes

- New standalone service (same repo as orquestr a): the **eval judge**,
  deployed as AWS serverless (CDK, following the telemetry collector's
  conventions).
- `POST /v1/evals` (free, per-platform-API-key rate-limited + 10/day mint
  allowance): validate → create the request pod's platform record (full
  request, public) → enqueue chain mint → `202 {evalId}`.
- Async judging by **orquestra nodes**, batched into the v1 datanet's
  on-chain epochs: the gateway fans each job out over a pull-based
  lease/ack protocol (lease carries podId + corpus URL, not the payload —
  nodes fetch the payload from the pod's platform record); each
  participating node independently retrieves top-k pods from the v1
  datanet and runs its own LLM judge → per-criterion 1–10 scores +
  critiques + citations. Settlement sweeps at epoch end + 1h: 1 answer =
  verdict served with `quorum {served: 1}` disclosed; 2+ answers = median
  scores + merged critiques + real agreement stats. Result: 0–100 overall
  score, accept/revise/reject decision, `action.route`, confidence,
  dissent (decision-flip rule), provenance. SLA: within 48h of the judging
  epoch's end.
- New `evalwork` lane in orquestra (`src/evalworker/`): opt-in always-on
  worker loop beside the scheduler, leasing only jobs for datanets the node
  participates in; LLM-token budget capped; isolated from vote/mint.
- `GET /v1/evals/{id}` poll.
- **Single datanet in v1**: no routing, no consent registry — every request
  is served against, and minted as a pod on, one Reppo-operated datanet
  (the demand record; per-topic datanets and routing are a later change).
- Service wallet mints pods on Base with a hard budget cap (refuse before
  signing) and async mint retry (mint failure never loses accepted work).

## Capabilities

### New Capabilities

- `eval-api`: HTTP surface — request validation, free-tier rate limiting,
  idempotent accept, job status polling, datanet listing.
- `eval-judging`: the node-side judge contract (evidence retrieval, scorer
  discipline, injection guard), quorum settlement (min 1 answer, target 2+,
  median + agreement when 2+), and the response object (verdicts, citations,
  evidence basis, quorum disclosure, provenance).
- `job-distribution`: the gateway↔node lease/ack protocol — pull-based
  leasing, visibility timeouts, at-least-once delivery, idempotent results,
  node authentication, and the orquestra `evalwork` worker lane.
- `pod-minting`: minting each request as a pod on its routed datanet — wallet
  custody (Secrets Manager), budget cap, mint retry, `podId: pending`
  semantics.
- `datanet-sync`: scheduled pull of the v1 datanet's pod content (Base RPC +
  reppo.ai API), embedding computation, S3 corpus storage.

### Modified Capabilities

(none — new service; no existing orquestra specs change)

## Impact

- New API (gateway service + CDK infra) **and** orquestra changes: new
  `src/evalworker/` lane, `evalWork` strategy-config block, dashboard eval
  activity rows.
- AWS: API Gateway HTTP API, Lambdas (intake, node lease/complete API,
  settlement, mint, sync, read), SQS (mint FIFO + DLQs), DynamoDB (jobs/
  leases/results/mint ledger), S3 (embeddings), EventBridge (sync schedule +
  settlement deadlines), Secrets Manager (wallet key).
- External dependencies: node LLM providers (via each operator's own keys),
  Base RPC, reppo.ai platform API, the v1 datanet on Base (Reppo-created
  or an existing Reppo-operated one).
- Costs: v1 is free, so node LLM tokens and pod mint fee/gas per request are
  subsidized by Reppo and bounded by rate limits + the wallet budget cap;
  wallet holds mint-fee float only.
