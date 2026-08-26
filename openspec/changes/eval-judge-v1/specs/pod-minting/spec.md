# pod-minting (delta)

## Purpose

Every eval request becomes an on-chain pod on the v1 datanet — the
demand record that replaces the unmet-demand feed — minted by a
budget-capped service wallet without ever blocking or losing accepted work.

## ADDED Requirements

### Requirement: Every request is minted

For every accepted eval the service SHALL mint a pod on the v1 datanet
containing the request record. The pod id SHALL appear in the
result's provenance.

#### Scenario: Accepted request becomes a pod

- **WHEN** an eval is accepted
- **THEN** a pod is minted on the v1 datanet and the settled result carries its `requestPodId`

### Requirement: Minting never blocks or loses accepted work

Judging SHALL NOT wait on mint success. If minting fails, the result settles
with `requestPodId: "pending"` and the mint is retried asynchronously with
bounded attempts; terminal mint failures SHALL be recorded and alertable,
never silently dropped.

#### Scenario: Base RPC outage does not fail evals

- **WHEN** Base RPC is down while evals arrive
- **THEN** verdicts still settle with `requestPodId: "pending"` and mints complete later from the retry queue

### Requirement: Budget-capped wallet

The service wallet SHALL enforce a hard spend cap (mint fees + gas) per time
window and SHALL refuse to sign once the cap is reached — before signing,
not after. Wallet balance and cap state SHALL be observable (metric/alarm).

#### Scenario: Cap reached

- **WHEN** the wallet's daily mint budget is exhausted
- **THEN** new mints queue (or mark `pending`) without signing, and an alarm fires; no transaction exceeds the cap

### Requirement: Payload publicity is disclosed

Because request pods are public, the API documentation and terms SHALL
prominently disclose that eval payloads become public on-chain/datanet
content. This disclosure MUST exist before the endpoint is publicly announced.

#### Scenario: Docs state publicity

- **WHEN** the endpoint is publicly announced
- **THEN** the published documentation states that submitted payloads are minted as public pods
