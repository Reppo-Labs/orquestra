# eval-api (delta)

## Purpose

The public HTTP surface of the eval judge: free (v1) request intake with
validation and rate limiting, and asynchronous job status polling. All v1
requests are served against a single Reppo-operated datanet.

## ADDED Requirements

### Requirement: Request validation

`POST /v1/evals` SHALL validate the request (schema, payload ≤ 32 KB, 1–10
criteria, `type` ∈ answer|plan|trace|artifact) and reject invalid requests
with `400` and a machine-readable reason.

#### Scenario: Malformed request rejected

- **WHEN** a request with a 40 KB payload or zero criteria is submitted
- **THEN** the service responds `400` with a machine-readable reason and no job is created

### Requirement: Caller authentication via gateway-issued API keys

The gateway SHALL issue caller API keys itself: `POST /v1/keys` with an
email returns a key exactly once (`201`), stores only its SHA-256 hash,
enforces one key per email (`409` on repeat), and rate-limits issuance per
source address. Callers SHALL authenticate with that key; requests with a
missing, malformed, or unknown key SHALL be rejected with `401` (validated
by hash lookup — never trusted as bare identity). All limits and
allowances apply per key (keyed internally by the hash).

#### Scenario: Key issued once

- **WHEN** an email requests a key twice
- **THEN** the first call returns a fresh key and the second answers `409` without issuing

#### Scenario: Unkeyed or unknown-key request rejected

- **WHEN** a request arrives without a key, or with a key whose hash is not on record
- **THEN** the service responds `401` and no job is created

### Requirement: Free tier with per-key rate limiting and mint allowance

v1 SHALL be free of charge. Because each accepted request spends real
resources (node LLM tokens, pod mint fee + gas), the service SHALL enforce
per-key limits: a token-bucket rate limit (10/hour, burst 3) and a
**mint allowance of 10 accepted requests per key per day**, both checked
at intake before acceptance — a request past either limit is rejected
`429` with a retry-after / quota-reset hint and no job is created. This
preserves the invariant that every accepted request is minted. A global
mint cap (100/day) additionally backstops the wallet. Acceptance SHALL be
idempotent per client-supplied idempotency key.

#### Scenario: Rate limit enforced

- **WHEN** a caller exceeds the configured request rate
- **THEN** the service responds `429` with a retry-after hint and creates no job

#### Scenario: Daily mint allowance exhausted

- **WHEN** a key submits its 11th request of the day
- **THEN** the service responds `429` with the quota-reset time and creates no job

#### Scenario: Retried submission accepted once

- **WHEN** the same request with the same idempotency key is delivered twice
- **THEN** exactly one job exists and both responses reference the same `evalId`

### Requirement: Async accept and poll

An accepted request SHALL return `202` with `{ evalId }`.
`GET /v1/evals/{evalId}` SHALL return
`status` ∈ pending|settled|failed, including the result object once settled.
The service makes no synchronous-latency promise; judging is epoch-batched
and the documented SLA is **a result within 48h of the judging epoch's
end** (jobs arriving in the last 3h of an epoch are judged in the next
epoch).

#### Scenario: Poll until settled

- **WHEN** a caller polls an accepted eval
- **THEN** it observes `pending` and later `settled` with the full result object, or `failed` with a reason

### Requirement: Failures are explicit

If a job terminally fails (no node answers by its epoch's answer cut-off),
the eval SHALL settle as `failed` with a reason. Failures MUST never be
silently dropped and SHALL be counted in service metrics.

#### Scenario: Unserved job surfaces

- **WHEN** no node answers a job by its epoch's answer cut-off
- **THEN** `GET /v1/evals/{id}` returns `failed` with a reason and the failure increments the unserved-jobs metric
