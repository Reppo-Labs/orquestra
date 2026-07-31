# rpc-read-cache

## Purpose

Bound the number of RPC and CLI read operations a node issues so that operating on free/public RPC endpoints is reliable: repeated reads of unchanged chain state are served from a cache with explicit freshness rules instead of re-querying.

## ADDED Requirements

### Requirement: Within-cycle read deduplication

The node SHALL issue at most one underlying read per distinct read operation (same query, same arguments) within a single cycle. Subsequent identical reads in the same cycle SHALL be served from the cycle's memoized result.

#### Scenario: Repeated pod listing in one cycle

- WHEN a cycle reads the pod list for a datanet more than once (e.g. for scoring and again for learning)
- THEN only the first read reaches the RPC/CLI, and later reads return the memoized result

#### Scenario: Memo does not outlive the cycle

- WHEN a new cycle starts
- THEN all cycle-scoped memoized reads are discarded and the first read of each operation is fresh

### Requirement: TTL caching for slow-moving reads

Reads whose results change rarely (the set of datanets and their metadata) SHALL be cached across cycles with a bounded time-to-live. A cached result older than its TTL SHALL be refreshed on next access.

#### Scenario: Datanet list served from cache

- WHEN the datanet list was fetched less than its TTL ago
- THEN a subsequent read (from the cycle, discovery, or the dashboard) returns the cached list without an RPC/CLI call

#### Scenario: Expired entry refreshes

- WHEN the datanet list cache entry is older than its TTL
- THEN the next read fetches fresh data and resets the entry

### Requirement: Epoch-derived expiry for epoch info

Epoch information SHALL be cached until the epoch can have rolled over, using the reported time remaining in the current epoch as the upper bound for cache validity.

#### Scenario: Mid-epoch read

- WHEN epoch info was read with N seconds remaining and less than N seconds have elapsed
- THEN a subsequent epoch read returns the cached value without querying

#### Scenario: Epoch boundary passed

- WHEN more time has elapsed than the cached epoch's reported remaining seconds
- THEN the next epoch read queries fresh state

### Requirement: Write-triggered invalidation

After the node executes an on-chain write (vote, mint, claim, grant), cached reads whose results that write can change SHALL be invalidated before they are next served.

#### Scenario: Vote invalidates vote-volume reads

- WHEN the node casts a vote on a pod
- THEN cached epoch vote volume and own-pod-vote reads are invalidated, and the next read reflects post-vote state

#### Scenario: Claim invalidates emissions reads

- WHEN the node claims emissions
- THEN cached claimable-emissions reads are invalidated

### Requirement: Caching never changes decisions unsafely

Serving a cached read SHALL NOT cause the node to repeat a write it already performed or exceed a budget cap. Idempotency (dedup records) and budget enforcement (ledger) SHALL remain authoritative regardless of read staleness.

#### Scenario: Stale pod list cannot double-vote

- WHEN a cached pod list still shows a pod the node already voted on this epoch
- THEN the existing vote dedup record prevents a second vote on that pod

#### Scenario: Cache failure degrades to direct reads

- WHEN the cache layer errors internally
- THEN reads fall through to the underlying RPC/CLI (correctness over savings), and the failure is logged
