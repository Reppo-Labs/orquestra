## Purpose

Defines the contract for what a telemetry payload may and may not contain, so that operators can rely on a fixed, inspectable boundary rather than on the current implementation happening to be careful.

## ADDED Requirements

### Requirement: The payload is built from an explicit allowlist

The payload SHALL be assembled by naming each transmitted field explicitly. Serializing an internal object and removing unwanted fields is prohibited. A field added to any internal type MUST NOT appear in the payload unless it is added to the allowlist.

#### Scenario: A new field is added to an internal type

- **WHEN** a field is added to a type the payload draws from, without being allowlisted
- **THEN** the transmitted payload is unchanged and the new field does not appear

#### Scenario: Allowlist drift is detected automatically

- **WHEN** the payload gains a field not present in the declared allowlist
- **THEN** the test suite fails

### Requirement: Prohibited data is never transmitted

The payload MUST NOT contain the operator's wallet address in any form, including hashed or truncated; datanet or subnet identifiers; strategy configuration values such as thresholds, vote rates, or selection counts; token balances, amounts, or ROI figures; pod names or pod content; panel transcripts; or RPC URLs.

Hashing SHALL NOT be treated as sufficient anonymization for wallet addresses, because the set of node addresses is small and publicly enumerable on-chain and is therefore reversible by brute force.

#### Scenario: Node with an active strategy transmits

- **WHEN** a node with telemetry enabled transmits while voting and minting on configured datanets
- **THEN** the payload contains no wallet address, no datanet identifier, and no strategy threshold

#### Scenario: Attempted transmission of a prohibited field

- **WHEN** a prohibited field would reach the payload
- **THEN** transmission fails closed and the field is not sent

### Requirement: Errors are transmitted as normalized signatures

Exceptions SHALL be reduced to a stable signature composed of the error class and normalized stack frames. Free-text error messages, and any operator-supplied or network-supplied string, MUST NOT be transmitted. All signature content SHALL pass through the existing redaction boundary before inclusion.

#### Scenario: An error containing a credential occurs

- **WHEN** an error message embeds an RPC URL carrying an API key
- **THEN** the transmitted signature contains no credential material

#### Scenario: The same fault occurs on two different nodes

- **WHEN** the same code path fails on two nodes with different configurations
- **THEN** both produce the same signature, so the fault is countable across installs

#### Scenario: An error message contains attacker-controlled text

- **WHEN** an error message embeds text originating from pod content or an external API
- **THEN** that text does not appear in the transmitted payload

### Requirement: Payloads are versioned

Every payload SHALL carry a schema version and the timestamp at which it was produced. The schema SHALL be documented in the repository and versioned alongside the code.

#### Scenario: Collector receives a payload

- **WHEN** any payload is transmitted
- **THEN** it carries a schema version and a production timestamp

#### Scenario: Schema changes in a later release

- **WHEN** the payload shape changes
- **THEN** the schema version is incremented and the documented schema is updated in the same change

### Requirement: Telemetry failure never affects node operation

Telemetry transmission SHALL be non-blocking and best-effort. Failure to build, send, or acknowledge a payload MUST NOT interrupt a cycle, delay voting or minting, or cause the node to exit.

#### Scenario: Collector is unreachable

- **WHEN** the collector endpoint is down or unreachable
- **THEN** the cycle completes normally and the node continues running

#### Scenario: Payload construction throws

- **WHEN** building the payload raises an error
- **THEN** the error is contained, nothing is transmitted, and the cycle is unaffected
