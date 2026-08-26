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

### Requirement: Free tier with rate limiting

v1 SHALL be free of charge. Because each accepted request spends real
resources (node LLM tokens, pod mint fee + gas), the service SHALL enforce
rate limits per caller and SHALL respond `429` when exceeded. Acceptance
SHALL be idempotent per client-supplied idempotency key.

#### Scenario: Rate limit enforced

- **WHEN** a caller exceeds the configured request rate
- **THEN** the service responds `429` with a retry-after hint and creates no job

#### Scenario: Retried submission accepted once

- **WHEN** the same request with the same idempotency key is delivered twice
- **THEN** exactly one job exists and both responses reference the same `evalId`

### Requirement: Async accept and poll

An accepted request SHALL return `202` with `{ evalId }`.
`GET /v1/evals/{evalId}` SHALL return
`status` ∈ pending|settled|failed, including the result object once settled.
The service makes no synchronous-latency promise; the documented SLA is
minutes-scale.

#### Scenario: Poll until settled

- **WHEN** a caller polls an accepted eval
- **THEN** it observes `pending` and later `settled` with the full result object, or `failed` with a reason

### Requirement: Failures are explicit

If a job terminally fails (no node answers by the deadline), the eval SHALL
settle as `failed` with a reason. Failures MUST never be silently dropped and
SHALL be counted in service metrics.

#### Scenario: Unserved job surfaces

- **WHEN** no node answers a job by the settlement deadline
- **THEN** `GET /v1/evals/{id}` returns `failed` with a reason and the failure increments the unserved-jobs metric
