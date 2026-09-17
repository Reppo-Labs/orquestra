# evalworker-gateway-contract Specification

## Purpose
Pins the lease / complete / deny / fail wire contract between this worker and the eval-api gateway, shared byte-for-byte through the vendored fixtures.
## Requirements
### Requirement: Lease carries no corpus reference
The worker SHALL parse a lease as `{ jobId, request, answerCutoff }` and SHALL reject (shape error) a lease carrying `corpusUrl`, `corpusVersion`, a top-level `datanetId`, or the retired `epoch` field.

#### Scenario: Old-shape lease
- **WHEN** the gateway returns a lease with `corpusUrl`
- **THEN** the client raises a shape-mismatch error naming version skew

### Requirement: Complete body shape
The completion shape is selected per lease by whether the leased request carries `criteria`. A criteria-free lease (no `criteria`) SHALL complete with `{ jobId, model, score 1-10, critique, citations: { datanetId, podId }[] }`; a legacy lease (with `criteria`, kept for the gateway rollback window) SHALL complete with `{ jobId, model, verdicts }` where each verdict is `{ criterion, score 1-10, critique, citations: { datanetId, podId }[] }`. Either shape SHALL carry at least one citation and SHALL NOT send `evidenceBasis`, and no legacy field SHALL leak into a criteria-free body. A gate or judge result whose shape disagrees with the leased format SHALL NOT be submitted: the node reports `:fail` (retryable). Both `datanetId` and `podId` are cuid **strings** — `datanetId` is the datanet's subnet cuid, never a numeric id — and the gateway resolves the pair against the same public datanet API the node read it from.

#### Scenario: Criteria-free lease
- **WHEN** a lease carries no `criteria`
- **THEN** `:complete` sends one `{ score, critique, citations }` body and no `verdicts` array

#### Scenario: Result shape disagrees with the lease
- **WHEN** the gate or the judge answers in the other contract's shape (either direction)
- **THEN** the node reports `:fail` and submits nothing

#### Scenario: Fixture round-trip
- **WHEN** the vendored `complete-request.json` is submitted through the client
- **THEN** the body sent equals the fixture byte-for-byte after JSON parse

### Requirement: Deny route
The worker SHALL expose `deny(jobId, reason, datanetsSearched: string[])` posting `{ jobId, reason, datanetsSearched }` (subnet cuids) to `/v1/node/jobs/{jobId}:deny`, and SHALL treat `409 ALREADY_ANSWERED` / `409 PAST_CUTOFF` / `400 INVALID_DENIAL` as terminal (no retry). `reason` SHALL be at most **2000 characters** (the gateway's `denyRequestSchema` cap): on a legacy lease the worker builds it by naming each unsupported criterion by its 1-based index plus a bounded excerpt, on a criteria-free lease by stating that no pod bears on the submitted output in context, and it names the datanets searched and hard-clamps the result either way. Overflowing the cap is a terminal 400 INVALID_DENIAL, which would settle the job `failed` rather than `denied`.

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

