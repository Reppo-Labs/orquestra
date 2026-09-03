## Purpose

Pins the lease / complete / deny / fail wire contract between this worker and the eval-api gateway, shared byte-for-byte through the vendored fixtures.

## ADDED Requirements

### Requirement: Lease carries no corpus reference
The worker SHALL parse a lease as `{ jobId, request, epoch, answerCutoff }` and SHALL reject (shape error) a lease carrying `corpusUrl`, `corpusVersion`, or a top-level `datanetId`.

#### Scenario: Old-shape lease
- **WHEN** the gateway returns a lease with `corpusUrl`
- **THEN** the client raises a shape-mismatch error naming version skew

### Requirement: Complete body shape
`:complete` SHALL send `{ jobId, model, verdicts }` where each verdict is `{ criterion, score 1-10, critique, citations: { datanetId, podId }[] }` with at least one citation, and SHALL NOT send `evidenceBasis`.

#### Scenario: Fixture round-trip
- **WHEN** the vendored `complete-request.json` is submitted through the client
- **THEN** the body sent equals the fixture byte-for-byte after JSON parse

### Requirement: Deny route
The worker SHALL expose `deny(jobId, reason, datanetsSearched)` posting `{ jobId, reason, datanetsSearched }` to `/v1/node/jobs/{jobId}:deny`, and SHALL treat `409 ALREADY_ANSWERED` / `409 PAST_CUTOFF` / `400 INVALID_DENIAL` as terminal (no retry). `reason` SHALL be at most **2000 characters** (the gateway's `denyRequestSchema` cap): the worker builds it by naming each unsupported criterion by its 1-based index plus a bounded excerpt, and hard-clamps the result. Overflowing the cap is a terminal 400 INVALID_DENIAL, which would settle the job `failed` rather than `denied`.

#### Scenario: Ten long unsupported criteria
- **WHEN** all ten criteria of a job are long and unsupported
- **THEN** the reason posted is at most 2000 characters and still names every unsupported criterion by index

#### Scenario: Deny fixture round-trip
- **WHEN** the vendored `deny-request.json` is submitted through the client
- **THEN** the body sent equals the fixture and the URL ends with `:deny`

### Requirement: Fixtures are byte-pinned in both repos
`test/fixtures/lease-ack/` SHALL byte-match eval-api's `fixtures/lease-ack/` and the pinned checksums; `corpus-snapshot.json` no longer exists.

#### Scenario: Drift guard
- **WHEN** any fixture differs from its pinned checksum
- **THEN** the contract suite fails
