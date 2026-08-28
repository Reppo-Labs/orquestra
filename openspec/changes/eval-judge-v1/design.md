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
2b. **Settlement policy: epoch-batched, deadline-driven** (revised
   2026-08-26 grilling, superseding the earlier ~5-min per-job deadline).
   Jobs batch into the v1 datanet's **on-chain epochs** on Base. A job
   belongs to the epoch it is accepted in, EXCEPT jobs arriving in the last
   **3h** of an epoch, which roll to the next epoch (guaranteed judging
   window). Answers are accepted until **epoch end + 1h** (hard cut-off by
   timestamp, not by "settlement already ran"); one settlement sweep per
   epoch runs at that point over ALL answers received (nodes stay
   quorum-oblivious). ≥1 answer = settled, 0 = `failed`. Outward SLA:
   result within **48h of the judging epoch's end**. This replaces the
   per-job EventBridge Scheduler timer with one epoch-end sweep, and
   retires `SETTLEMENT_DEADLINE_SECONDS`/`LEASE_TTL_SECONDS` in favor of
   epoch-derived deadlines.
2c. **Result shape** (2026-08-26): overall `verdict.score` on **0–100**
   (mean of per-criterion median scores × 10); `decision`: ≥70 accept,
   40–69 revise, <40 reject. `confidence.agreement` =
   `1 − meanPairwiseAbsDiff(per-node overall scores)/90`, null when
   served = 1; `confidence.dispersion` low ≥0.85 / medium 0.6–0.85 /
   high <0.6. `action.route`: auto-ship = accept AND agreement ≥ 0.8 AND
   served ≥ 2; block = reject; else review — fixed defaults in v1
   (caller-supplied risk threshold is v2). NO `est_error` in v1 (needs
   calibration data; outcome-vs-verdict logging starts day one so it can
   exist later). `dissent` = decision-flip rule: a node dissents when its
   own implied decision differs from the settled decision; populate with
   the most divergent such node, note from its largest-gap criterion.
   Per-criterion node scores stay 1–10 integers on the wire (node contract
   unchanged); the gateway converts. All thresholds are config knobs.
3. **Corpus: one S3 JSON TEXT corpus object** for the v1 datanet, maintained
   by the gateway's sync Lambda (temp key + atomic copy, pointer-last
   commit, last-good wins). AMENDED (already shipped in the worker's
   retrieve.ts): v1 carries pod TEXT, no embeddings — nodes rank lexically
   (tf-idf overlap), because several node LLM providers (anthropic-oauth)
   expose no embeddings endpoint for the query side. The gateway therefore
   computes no embeddings in v1; when embeddings return (v2), the gateway
   side is Bedrock (decided 2026-08-26 — AWS-only, IAM not API keys), and
   the open half is node-side query embedding. Nodes fetch the corpus via
   a presigned S3 URL in the lease payload — every node retrieves from the
   same evidence snapshot, which makes citations verifiable at settlement. Corpus objects are **version-addressed**
   (`corpus/<datanetId>/<version>.json` + `latest` pointer); each lease
   records the version it presigned, and submitted citations must resolve
   against **that version's** pod-id manifest (kept queryable without
   loading the full corpus). Old versions lifecycle-expire after the
   longest possible settlement window. Resolution against live chain or a
   rotated snapshot is rejected as unfair discard. Alt: each node builds its own index (the 07-29
   spec's design) — deferred; heavier orquestra work and unverifiable
   snapshots.
4. **Single datanet, no routing** (decided 2026-08-26): every request is
   served against, and minted on, one Reppo-operated datanet. No consent
   registry, no matching, no modes; `evidenceBasis` per answer
   (citations vs model-judgment) is the only grounding disclosure.
   Per-topic datanets + routing return as a later change if usage justifies
   them.
5. **Free tier control = gateway-issued API keys + per-key limits +
   idempotency keys** (AMENDED 2026-08-28 — the platform's agent-key space
   never fit callers, and unvalidated keys let fabricated identities
   multiply allowances). The gateway issues keys itself: `POST /v1/keys`
   {email} → `rk_…` shown once, SHA-256 hash stored, one key per email,
   issuance IP-rate-limited; intake validates by hash lookup and uses the
   hash as the caller identity everywhere. Unkeyed/unknown keys get `401`.
   Emails give the kill-criteria metrics real distinct-user grounding.
   All limits are per key:
   token-bucket 10/hour burst 3 as the shaper, and a **mint allowance of
   10/day per key** checked at intake — request #11 is rejected (`429` +
   quota-reset time) BEFORE acceptance, preserving "every accepted request
   is minted". A **global mint cap of 100/day** backstops the wallet.
   Signup friction is a feature for the demand test: registered keys make
   the distinct-user and repeat-user kill metrics honest. No payment code
   in v1.
6. **Mint pipeline: metadata pod via the CURRENT platform/chain API, FIFO
   async** (REVISED 2026-08-26, superseding the same-day platform-first
   variant: the gateway takes NO new platform dependencies). The pod is a
   **metadata demand record** — type, criteria, payloadHash, submittedAt,
   epoch — minted at intake through the mint flow as it exists today
   (chain mint by the gateway wallet; platform indexing per the existing
   API). The payload itself is NOT in the pod. Mint is fire-and-forget via
   the FIFO queue (single consumer serializes nonce use):
   `requestPodId: "pending"` until confirmed, bounded retries then
   terminal alarm; judging never waits on the mint. The verdict lives ONLY
   in the gateway's result object; `provenance.receipt` = the mint tx
   hash. Pods are public and votable through normal datanet epoch voting.
6b. **Every call an eval needs is served by eval-api itself** (2026-08-26).
   The lease response carries the request INLINE (type, payload, criteria,
   context) plus the epoch-model fields (`epoch`, `answerCutoff`,
   `corpusVersion`) and the presigned corpus URL. Nodes never call the
   platform to judge; the platform is not in the judging hot path.
7. **Budget caps in DynamoDB mint ledger** (conditional update, refuse
   before signing) — orquestra `BudgetLedger` discipline. Two layers:
   per-key 10/day (checked at intake, see 5) and global 100/day.
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

## Resolved (2026-08-26 grilling)

- Rate limits: per platform API key — 10/hour burst 3, mint allowance
  10/day per key, global 100/day.
- Settlement timing: epoch-batched (see decision 2b); the old
  deadline/lease-TTL knobs are retired.
- Account placement: collector's account (wallet holds mint-fee float
  only; revisit if v2 monetizes).
- Contract fixtures: copied between repos + checksum guard in both CIs
  (no shared package until a third consumer exists).
- Build order: pure-logic modules first (settlement, ledgers, limits),
  CDK last.

## Open Questions

- ~~Node auth validation~~ RESOLVED 2026-08-27: `GET /api/v1/agents/:id/pods`
  (Bearer apiKey) is the non-mutating validation route — 401 "Invalid API
  key" confirmed live on bad creds; the 2xx side is a launch-smoke item
  with real house-node creds.
- v1 datanet epoch duration (read on-chain; feeds the SLA doc math —
  48h promise assumes epoch ≤ ~46h).
- Orquestra evalworker (task 6, built against the 5-min contract) needs a
  small revision pass: epoch-model fields in the lease/fixtures
  (`epoch`, `answerCutoff`, `corpusVersion` replacing `leaseExpiresAt`/
  `settlementDeadline`); the inline request stays.
