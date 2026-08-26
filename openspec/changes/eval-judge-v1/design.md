# Design: eval-judge-v1

## Context

See `proposal.md` for motivation. Governing docs:
`docs/superpowers/specs/2026-08-26-eval-api-v1-generic-datanet-design.md`
(product design), `docs/superpowers/research/2026-08-12-eval-api-market-research.md`
(market case + kill criteria). Prior art: the telemetry collector
(`collector/cdk/stack.ts`) — CDK, API GW HTTP API, Node 22 ESM Lambdas,
DynamoDB TTL, EventBridge schedule, bounded log retention. Constraints:
AWS-only, near-zero idle cost (30-day demand test), **v1 free of charge**,
judging by orquestra nodes (min 1 answer, target 2+) — no service-run judge.

## Goals / Non-Goals

**Goals:**
- Publicly usable endpoint within the smallest build; usage measurable
  (distinct users, repeats) against the kill criteria.
- Idle cost ≈ $0; per-request subsidy (node LLM tokens, mint fee+gas)
  bounded by rate limits and the wallet budget cap.
- Zero-loss guarantees at the seams: accepted work survives node churn, mint
  failures, and process crashes.
- Real quorum from day one at demand-test scale: settle on 1 answer, target
  2+; agreement/dissent populated whenever served ≥ 2.

**Non-Goals:**
- Quorum targets above 2, human judges, staking, node reputation (v2+).
- Payments of any kind (x402/API-key/prepaid) — v1 is free; monetization is
  a separate later change if usage exists. No refunds concept needed.
- Enterprise features, webhooks (poll only).
- ACP evaluator integration (separate follow-up change).

## Decisions

1. **Fresh repo (`eval-api`), collector-shaped CDK stack.** One stack: API
   GW HTTP API → Lambdas (intake, read, node lease/complete/fail API,
   settlement, mint, sync) + SQS FIFO mint queue (+ DLQs) + DynamoDB
   single-table (jobs, leases, node answers, results, mint ledger, rate
   buckets) + S3 embeddings bucket + EventBridge (hourly sync +
   settlement-deadline timer)
   + Secrets Manager. The job queue is a DynamoDB lease table (not SQS):
   nodes long-poll an HTTP lease endpoint, so lease state must be queryable
   and re-offerable — SQS remains for the internal mint pipeline only. Alt
   considered: Fargate (idle cost, new ops pattern) and hybrid (premature) —
   rejected per the architecture review.
2. **Judges = orquestra nodes with their operators' own LLM keys** (decided
   2026-08-26, reversing the earlier single-LLM plan). Each answer reports
   its model id; settlement records all of them in provenance. The gateway
   runs no LLM calls, so no Anthropic key exists gateway-side.
2b. **Settlement policy: deadline-driven only.** Jobs stay open until the
   settlement deadline; ALL answers received by then are included (nodes are
   quorum-oblivious and always judge what they lease). At deadline: ≥1
   answer = settle (median scores, merged critiques, agreement when ≥2),
   0 = `failed`. No early settle-at-target — an early cut-off would discard
   late votes and make node work order-dependent. EventBridge Scheduler
   fires the deadline check per job. Latency = the deadline, a config knob
   (start ~5 min).
3. **Embeddings: one S3 JSON corpus object** for the v1 datanet, maintained
   by the gateway's sync Lambda (temp key + atomic copy, last-good wins).
   Nodes fetch the corpus via a presigned S3 URL in the lease payload and
   brute-force cosine locally (corpus ≈ 10³–10⁴ vectors) — every node
   retrieves from the same evidence snapshot, which makes citations
   verifiable at settlement. Alt: each node builds its own index (the 07-29
   spec's design) — deferred; heavier orquestra work and unverifiable
   snapshots.
4. **Single datanet, no routing** (decided 2026-08-26): every request is
   served against, and minted on, one Reppo-operated datanet. No consent
   registry, no matching, no modes; `evidenceBasis` per answer
   (citations vs model-judgment) is the only grounding disclosure.
   Per-topic datanets + routing return as a later change if usage justifies
   them.
5. **Free tier control = rate limiting + idempotency keys** (token bucket
   per caller key/IP in DynamoDB, `429` over limit). No payment code at all
   in v1; the abuse bound on spend is rate limits × per-request cost, capped
   hard by the mint budget ledger and node-side LLM budgets.
6. **Mint pipeline: FIFO queue, single consumer** — serializes nonce use
   without nonce-management code. Mint is fire-and-forget from intake:
   `requestPodId: "pending"` until confirmed; bounded retries then terminal
   failure alarm. Judge never waits on mint.
7. **Budget cap in DynamoDB mint ledger** (conditional update, refuse before
   signing) — orquestra `BudgetLedger` discipline, same reasoning.
8. **Secrets Manager for the wallet key** (mint-fee float only;
   KMS-secp256k1 signing deferred). Node LLM keys never touch the gateway —
   each operator's keys stay in their own node env.
9. **Idempotent accept** via client idempotency key → DynamoDB conditional
   put mapping to `evalId`.
10. **The v1 datanet is a real datanet on Base** operated by Reppo (created
    fresh or reusing an existing Reppo-operated one); subnet fees configured
    minimal so the per-request mint subsidy stays negligible.

## Risks / Trade-offs

- [Free tier invites abuse: each request spends node tokens + mint fees] →
  rate limits per caller, hard wallet budget cap, node-side LLM budget caps;
  alarm on spend rate; kill switch = disable intake.
- [Lambda cold start loads S3 corpus per invocation] → corpus objects are
  small (<10 MB); acceptable at demand-test volume; memoize per container.
- [Nonce/stuck-tx on Base halts minting] → FIFO single-consumer + stuck-tx
  timeout → rebroadcast with bumped gas; worst case pods stay `pending`
  (accepted by spec).
- [Public payloads deter customers] → disclosed in docs/terms;
  `private: true` no-mint option is a fast-follow if buyers ask.
- [Prompt injection in payloads] → node judge injection guard + the Phase 0
  probe set as regression tests in CI.
- [Thin node supply: zero nodes answering → jobs fail] → Reppo runs 1–2
  house nodes with evalwork enabled from day one, so min-1 quorum is always
  reachable; unserved-jobs metric alarms.

## Migration Plan

Greenfield. Deploy order: create (or designate) the v1 datanet on Base →
deploy stack to the collector's account/region unless DevOps objects →
enable evalwork on 1–2 house orquestra nodes → smoke: 400 invalid, 429
over-limit, 202→settled round-trip through a real node, pod visible on the
datanet → fund wallet with float → publish docs + announce. Rollback = delete stack; DynamoDB/S3 retain (results survive).

## Open Questions

- Rate limit numbers (requests/day per caller; set from measured per-request
  subsidy cost, config-only).
- Lease visibility timeout + settlement deadline final numbers (tune during
  implementation).
- Account placement (default: collector's account; DevOps may want a
  separate account for the funded wallet).
