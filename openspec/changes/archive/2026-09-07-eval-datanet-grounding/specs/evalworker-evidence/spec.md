## Purpose

Defines how an orquestra node grounds an evaluation verdict in datanet pods it can read, and when it must deny a job instead of judging.

## ADDED Requirements

### Requirement: Evidence comes from the datanets this node can read
For each leased job the node SHALL retrieve candidate pods from every datanet it can access, rank them by relevance to the request and criteria, and consider only those candidates as evidence. The node SHALL NOT use any gateway-provided corpus.

A datanet SHALL be identified by its **subnet cuid string** (e.g. `cms3uejpj0001jf040zjgwqwm`) everywhere it is named — in `Citation.datanetId`, `DatanetPod.datanetId`, `datanetsSearched`, and the `"datanetId/podId"` pod keys the gate and judge prompts use. The node SHALL NOT identify a datanet by the numeric `tokenId` on its subnet row: that value collides across chains, and pods exist on subnets that carry no listed numeric id at all. The datanet API the node reads is public and unauthenticated, so "the datanets this node can access" is every datanet the API lists, not a per-credential subset.

#### Scenario: Two accessible datanets
- **WHEN** the node can read datanets `cms3uejpj0001jf040zjgwqwm` and `cmnhuowns000bic04e16t6735` and leases a job
- **THEN** candidate pods are drawn from both, each tagged with its datanet id

#### Scenario: One datanet of several is unreadable
- **WHEN** one accessible datanet fails while another answers
- **THEN** the job proceeds on what was read, and `datanetsSearched` names only the datanets actually read

#### Scenario: Datanet source unavailable
- **WHEN** the datanet source throws while listing, or every accessible datanet fails to answer
- **THEN** the node reports `:fail` with the error (retryable) and does not deny or judge

### Requirement: Relevance gate before judging
Before judging, the node SHALL run a bounded relevance check that selects, per criterion, which candidate pods actually bear on that criterion. Lexical overlap alone SHALL NOT qualify a pod as evidence.

#### Scenario: Pod mentions a keyword but not the claim
- **WHEN** a candidate pod shares vocabulary with a criterion but does not address it
- **THEN** the gate excludes it and it cannot be cited for that criterion

### Requirement: Deny instead of fabricate, but only on a complete read
If the gate finds no supporting pod for at least one criterion AND the node read every datanet it can access, the node SHALL deny the job via the gateway's deny route with a reason naming the unsupported criteria and the list of datanet ids read, and SHALL NOT submit any verdict. The reason SHALL fit the gateway's 2000-character limit.

A denial is terminal gateway-side, so the node SHALL NOT deny while any accessible datanet was unreadable on this job: absence of evidence is only evidence of absence once everything reachable has been read. In that case the node SHALL report `:fail` (retryable) naming the unreadable datanets.

#### Scenario: No evidence for one criterion, every datanet read
- **WHEN** criteria are [c1, c2], every accessible datanet was read, and the gate finds pods for c1 only
- **THEN** the node calls deny with a reason naming c2 and `datanetsSearched` = the datanets it read, and never calls complete

#### Scenario: No candidates at all, every datanet read
- **WHEN** retrieval returns zero pods across all accessible datanets and none failed
- **THEN** the node denies without spending a judge call

#### Scenario: A datanet was unreadable and nothing supports a criterion
- **WHEN** one accessible datanet could not be read and the gate finds no support for some criterion
- **THEN** the node reports `:fail` naming the unreadable datanet ids and never calls deny

#### Scenario: A datanet was unreadable but the evidence found still supports every criterion
- **WHEN** one accessible datanet could not be read and the gate supports every criterion from what was read
- **THEN** the node judges and completes normally, and `datanetsSearched` names only the datanets actually read

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
