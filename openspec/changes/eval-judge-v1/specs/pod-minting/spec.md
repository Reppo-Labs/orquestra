# pod-minting (delta)

## Purpose

Every eval request becomes an on-chain pod on the v1 datanet — the
demand record that replaces the unmet-demand feed — minted by a
budget-capped service wallet without ever blocking or losing accepted work.

## ADDED Requirements

### Requirement: Every request is minted as a metadata pod

For every accepted eval the service SHALL mint a pod on the v1 datanet
through the platform/chain API **as it exists today** — no new platform
capabilities. The pod is a **metadata demand record**: type, criteria,
payloadHash, submittedAt, epoch. The payload itself is NOT in the pod.
Pods are public and votable through the datanet's normal epoch voting.
The pod id SHALL appear in the result's provenance and the confirmed mint
tx hash as `provenance.receipt`. The verdict lives only in the gateway's
result object.

#### Scenario: Accepted request becomes a metadata pod

- **WHEN** an eval is accepted
- **THEN** a metadata pod mint is enqueued and the settled result carries its `requestPodId` and, once confirmed, the mint tx hash as `receipt`

### Requirement: Minting never blocks or loses accepted work

Judging SHALL NOT wait on mint success — the lease serves the payload
from the gateway. If minting fails, the result settles with
`requestPodId: "pending"` and the mint is retried asynchronously with
bounded attempts; terminal mint failures SHALL be recorded and alertable,
never silently dropped.

#### Scenario: Base RPC outage does not fail evals

- **WHEN** Base RPC is down while evals arrive
- **THEN** judging proceeds, verdicts settle with `requestPodId: "pending"`, and mints complete later from the retry queue

### Requirement: Budget-capped wallet

The service wallet SHALL enforce hard mint caps — **10 per key per day**
(checked at intake, where over-allowance requests are rejected before
acceptance) and **100 per day globally** — and SHALL refuse to sign once a
cap is reached — before signing, not after. Wallet balance and cap state
SHALL be observable (metric/alarm).

#### Scenario: Global cap reached

- **WHEN** the global daily mint budget is exhausted
- **THEN** new mints queue (or mark `pending`) without signing, and an alarm fires; no transaction exceeds the cap

### Requirement: Metadata publicity is disclosed

Because request pods are public metadata records, the API documentation
and terms SHALL disclose that each request's TYPE and CRITERIA (and a
hash of the payload) become public datanet content; the payload itself is
never minted. This disclosure MUST exist before the endpoint is publicly
announced.

#### Scenario: Docs state publicity

- **WHEN** the endpoint is publicly announced
- **THEN** the published documentation states that request criteria are minted as public pod metadata while payloads stay private (hash-anchored only)
