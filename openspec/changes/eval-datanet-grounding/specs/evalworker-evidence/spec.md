## Purpose

Defines how an orquestra node grounds an evaluation verdict in datanet pods it can read, and when it must deny a job instead of judging.

## ADDED Requirements

### Requirement: Evidence comes from the datanets this node can read
For each leased job the node SHALL retrieve candidate pods from every datanet its own credentials can access, rank them by relevance to the request and criteria, and consider only those candidates as evidence. The node SHALL NOT use any gateway-provided corpus.

#### Scenario: Two accessible datanets
- **WHEN** the node can read datanets 27 and 31 and leases a job
- **THEN** candidate pods are drawn from both, each tagged with its datanet id

#### Scenario: Datanet source unavailable
- **WHEN** the datanet source throws while listing or fetching
- **THEN** the node reports `:fail` with the error (retryable) and does not deny or judge

### Requirement: Relevance gate before judging
Before judging, the node SHALL run a bounded relevance check that selects, per criterion, which candidate pods actually bear on that criterion. Lexical overlap alone SHALL NOT qualify a pod as evidence.

#### Scenario: Pod mentions a keyword but not the claim
- **WHEN** a candidate pod shares vocabulary with a criterion but does not address it
- **THEN** the gate excludes it and it cannot be cited for that criterion

### Requirement: Deny instead of fabricate
If the gate finds no supporting pod for at least one criterion, the node SHALL deny the job via the gateway's deny route with a reason naming the unsupported criteria and the list of datanet ids searched, and SHALL NOT submit any verdict.

#### Scenario: No evidence for one criterion
- **WHEN** criteria are [c1, c2] and the gate finds pods for c1 only
- **THEN** the node calls deny with a reason naming c2 and `datanetsSearched` = the datanets it read, and never calls complete

#### Scenario: No candidates at all
- **WHEN** retrieval returns zero pods across all accessible datanets
- **THEN** the node denies without spending a judge call

### Requirement: Every verdict cites gated evidence
The judge SHALL cite at least one gated pod per criterion, as `{ datanetId, podId }`. Citations outside the gated set SHALL be stripped; a verdict left with zero citations after stripping is a judge error: the node SHALL report `:fail` (retryable) and SHALL NOT submit the answer.

#### Scenario: Judge cites an ungated pod
- **WHEN** the judge output cites a pod id not in the gated set for that criterion
- **THEN** that citation is removed and, if the verdict still has one gated citation, the answer is submitted

#### Scenario: Judge cites nothing for a criterion
- **WHEN** the judge output has a criterion with no gated citation
- **THEN** the node reports `:fail` and does not submit

### Requirement: Denials and gate calls are budgeted and recorded
The relevance gate SHALL count as one judge call against `maxJudgeCallsPerDay`. A denial SHALL be recorded in the activity log with status `denied` and the reason. A reservation SHALL be released when the job fails before the first model call.

#### Scenario: Datanet outage after reserving
- **WHEN** the reservation is taken and retrieval then fails (or no datanet is accessible, or the gate short-circuits on zero candidates)
- **THEN** the reservation is released and the day's used count is unchanged

#### Scenario: Budget exhausted before the gate
- **WHEN** the budget has no calls left
- **THEN** the node reports `:fail` with the budget reason before retrieving or gating
