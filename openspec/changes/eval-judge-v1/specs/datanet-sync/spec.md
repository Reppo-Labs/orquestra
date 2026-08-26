# datanet-sync (delta)

## Purpose

Keeping the judges' evidence fresh: scheduled ingestion of the v1 datanet's
pod content and maintenance of the embedding corpus nodes retrieve against.

## ADDED Requirements

### Requirement: Scheduled corpus refresh

The service SHALL refresh the v1 datanet's pod corpus on a schedule
(hourly-class), pulling pod content from the chain and platform APIs,
computing embeddings, and atomically replacing the corpus. A failed refresh
SHALL leave the previous corpus in place (last-good wins).

#### Scenario: Failed refresh keeps serving

- **WHEN** the platform API errors during a scheduled refresh
- **THEN** retrieval continues against the previous corpus and the failure is logged

### Requirement: New request pods become evidence

Pods minted from incoming requests SHALL appear in the corpus after the next
scheduled refresh without redeployment, so the datanet's accumulated request
history becomes retrievable evidence.

#### Scenario: Request pod becomes retrievable

- **WHEN** a request pod is minted and the next refresh completes
- **THEN** that pod is present in the corpus nodes retrieve against
