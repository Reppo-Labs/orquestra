# rpc-call-batching

## Purpose

Collapse per-pod and per-epoch eth_call grids into aggregated multicall requests so request count grows with batch count, not pod count, keeping cycles within free/public RPC rate limits as datanets grow.

## ADDED Requirements

### Requirement: Grid reads are batched

Read operations that issue one eth_call per pod or per (pod, epoch) pair — epoch vote volumes, claim-status and vote-gate reads in the emissions scans, subnet pool reads — SHALL be executed as aggregated multicall requests when the chain provides a multicall contract. The number of RPC requests for a grid of N calls SHALL be at most ⌈N / batch-size⌉ plus a constant. Reads whose outcome depends on the caller identity (`msg.sender`), such as claim-probe eth_calls issued with a `from` address, SHALL NOT be routed through the multicall contract and SHALL keep their serial semantics.

#### Scenario: msg.sender-dependent probe stays serial

- WHEN the emissions scan probes whether a claim would revert using an eth_call with the wallet as `from`
- THEN that probe is issued directly (not via multicall), so its revert/no-revert outcome reflects the wallet as caller

#### Scenario: Vote volume for many pods

- WHEN a cycle needs vote volumes for 100 pods (200 individual reads today)
- THEN the node issues at most a few aggregated requests rather than 200 individual eth_calls, and obtains the same per-pod values

#### Scenario: Batch size is bounded

- WHEN a grid exceeds the maximum batch size
- THEN it is split across multiple aggregated requests rather than sent as one oversized request

### Requirement: Per-call failure semantics are preserved

Reads that use call revert as signal (a claimable check where revert means "nothing due") SHALL preserve per-call success/revert outcomes inside a batch. One reverting call SHALL NOT fail the batch or be conflated with other calls' results.

#### Scenario: Mixed claimable results in one batch

- WHEN a batch contains claim-probe calls where some revert (nothing due) and some succeed (claimable)
- THEN each (pod, epoch) is classified individually, identical to serial execution

### Requirement: Fallback when multicall is unavailable

The node SHALL detect once per chain whether a multicall contract is deployed, and SHALL fall back to serial per-call execution when it is not. Detection SHALL not repeat on every cycle.

#### Scenario: Chain without multicall

- WHEN the configured chain has no multicall contract deployed
- THEN grid reads run serially exactly as they do today, with no behavior change

#### Scenario: Detection is cached

- WHEN multicall availability has been determined for a chain
- THEN subsequent cycles reuse the determination without re-probing

#### Scenario: Batched request fails transiently

- WHEN an aggregated request fails (rate limit, transport error)
- THEN the read reports failure the same way the serial path does today (the caller's existing per-datanet isolation and retry-next-cycle behavior applies), and a batch failure SHALL NOT silently drop individual results
