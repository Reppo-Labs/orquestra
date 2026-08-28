# job-distribution (delta)

## Purpose

How eval jobs reach orquestra nodes: a pull-based lease/ack protocol where
workers dial out to the gateway, leases expire and requeue, results are
idempotent, and the orquestra `evalwork` lane serves jobs without touching
the vote/mint cycle.

## ADDED Requirements

### Requirement: Pull-based lease protocol

Nodes SHALL obtain work by long-polling a lease endpoint; the gateway SHALL
never push to nodes. Leases are per (job, node): an open job (belonging to
the current judging epoch) SHALL be offered to every polling node that has
not yet answered it, so any number of nodes can serve the same job
concurrently; a node SHALL NOT be offered the same job twice. Delivery is
at-least-once and result submission SHALL be idempotent per `jobId` + node.

The lease response carries the **request inline** (type, payload,
criteria, context) plus the epoch-model coordination fields: the presigned
`corpusUrl` with its `corpusVersion`, the job's `epoch`, and the
`answerCutoff`. Every call an eval needs is served by the gateway itself —
nodes never call the reppo.ai platform to judge, and the platform is not
in the judging hot path.

#### Scenario: Lease is self-sufficient

- **WHEN** a node receives a lease
- **THEN** the lease body contains the full request and the corpus URL, and the node can judge without calling any service other than the gateway and S3

#### Scenario: Two nodes lease the same job

- **WHEN** two nodes long-poll while a job is open
- **THEN** both receive it, and both answers are accepted

#### Scenario: Crashed node does not block the job

- **WHEN** a node leases a job and goes silent
- **THEN** other nodes still receive and answer the job, and settlement proceeds at the deadline

#### Scenario: Duplicate result submission is safe

- **WHEN** a node submits the same result twice (network retry)
- **THEN** the answer is recorded once and the second submission succeeds without side effects

### Requirement: Node authentication and eligibility

Lease and result endpoints SHALL authenticate nodes with their existing
platform agent identity (agentId + apiKey). In v1 every authenticated node
may serve the single datanet's jobs.

#### Scenario: Unauthenticated lease rejected

- **WHEN** a caller without a valid agentId + apiKey long-polls the lease endpoint
- **THEN** the request is rejected and no job is offered

### Requirement: Nodes are quorum-oblivious

Quorum and settlement are exclusively the gateway's concern. A node that
leases a job SHALL always judge and submit its answer; the node-side
protocol carries no quorum state, no settlement logic, and no knowledge of
how many other nodes are serving the job. The gateway SHALL accept every
answer submitted before the job's epoch answer cut-off (epoch end + 1h).

#### Scenario: Node answers without quorum knowledge

- **WHEN** a node leases a job that another node is already serving
- **THEN** it judges and submits normally, and its answer is accepted and included in settlement

### Requirement: Orquestra evalwork lane

Orquestra SHALL gain an opt-in `evalWork` config block
(`{ enabled, maxConcurrent }`), hot-reloaded like other strategy
config, running an always-on worker loop beside the scheduler — not inside
the vote/mint cycle. Eval work spends LLM tokens only, capped by a dedicated
ledger line; the worker SHALL stop leasing when the budget is spent, and the
node wallet signs nothing for evals. Evalworker failure SHALL never affect
voting or minting.

#### Scenario: Budget exhaustion stops leasing

- **WHEN** a node's daily eval LLM budget is spent mid-day
- **THEN** the worker stops leasing new jobs until the window resets, and in-flight jobs complete

#### Scenario: Worker failure is isolated

- **WHEN** the evalworker crashes repeatedly
- **THEN** the node's vote/mint cycles continue unaffected

### Requirement: Contract tests at the seam

The lease/ack protocol SHALL be pinned by one fixture suite exercised against
BOTH the gateway implementation and the orquestra worker, so the two sides
cannot drift. The fixtures are **copied into both repos with a checksum
guard in each CI** (no shared package in v1): unilateral change on either
side fails that side's CI.

#### Scenario: Protocol drift fails CI

- **WHEN** the gateway changes a lease response field the worker relies on
- **THEN** the shared contract suite fails in CI before deployment
