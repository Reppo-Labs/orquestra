## Purpose

Governs whether a node transmits: the notice an operator receives before anything is sent, how an install is identified anonymously, and how an operator inspects or disables telemetry at any time.

## ADDED Requirements

### Requirement: Telemetry is enabled by default

The node SHALL transmit telemetry unless the operator has disabled it. Telemetry is on by default because the collector's admission threshold is expressed in distinct installs, and a small opted-in fraction of a small fleet would never reach it — leaving collected data permanently unconsumable.

This default is only defensible because the payload contains no personal or identifying data (`specs/telemetry-payload`). If that ever ceases to hold, this requirement MUST be revisited before the payload changes.

#### Scenario: Node runs with no stored decision

- **WHEN** a node starts, has shown the first-run notice, and no explicit decision is stored
- **THEN** telemetry is transmitted

#### Scenario: Operator has disabled telemetry

- **WHEN** the operator has disabled telemetry by command or environment variable
- **THEN** no telemetry is transmitted and no network request is made to the collector

#### Scenario: Stored decision is unreadable or corrupt

- **WHEN** the stored telemetry decision cannot be read or parsed
- **THEN** the node treats it as the default (enabled), records that the state was reset, and re-shows the notice before transmitting

### Requirement: No transmission before the operator has been notified

The node MUST NOT transmit telemetry until it has displayed the telemetry notice at least once and recorded that it did so. The notice SHALL state what is collected, what is never collected, how to inspect the exact payload, how to disable it, and the retention period.

This requirement is what distinguishes a default-on design from a covert one: the operator is always informed before the first byte leaves, even though they are not asked to act.

#### Scenario: Very first run of a fresh node

- **WHEN** a node starts for the first time and has never displayed the notice
- **THEN** the notice is displayed and no telemetry is transmitted during that run

#### Scenario: Subsequent runs after the notice was shown

- **WHEN** a node starts and the notice has previously been displayed
- **THEN** telemetry is transmitted without re-displaying the notice

#### Scenario: Operator upgrades a node that predates telemetry

- **WHEN** an existing node is upgraded to a version that includes telemetry
- **THEN** it is treated as never having displayed the notice, so the notice is shown and nothing is transmitted until the following run

### Requirement: Onboarding surfaces the decision prominently

The onboarding interview SHALL state that telemetry is enabled, in plain language, and SHALL offer disabling it as an immediate choice without requiring the operator to leave onboarding or consult documentation.

#### Scenario: Operator completes onboarding

- **WHEN** the operator reaches the telemetry step during onboarding
- **THEN** the node states that anonymous software-health data is collected, states that wallet address, strategy, and datanets are never sent, and offers to disable it

#### Scenario: Operator disables during onboarding

- **WHEN** the operator chooses to disable telemetry during onboarding
- **THEN** the decision is persisted and no telemetry is transmitted, including for that run

#### Scenario: Onboarding is re-run on a node that already decided

- **WHEN** onboarding runs again on a node with a stored decision
- **THEN** the prior decision is presented as the default and is preserved if the operator does not change it

### Requirement: Each install has an anonymous, non-derived identifier

The node SHALL generate a random identifier on first run and persist it in `DATA_DIR`. The identifier MUST NOT be derived from the operator's wallet address, hostname, MAC address, or any other machine or account characteristic.

#### Scenario: First run generates an identifier

- **WHEN** a node starts and no install identifier exists
- **THEN** a random identifier is generated and persisted, and it is stable across subsequent restarts

#### Scenario: Two nodes on the same machine

- **WHEN** two nodes run on one machine with different `DATA_DIR` values
- **THEN** they have different install identifiers, and neither identifier can be computed from the other

#### Scenario: Identifier is not reversible to an operator

- **WHEN** an install identifier is inspected
- **THEN** it yields no information about the wallet, host, or operator

### Requirement: Operators can inspect the exact payload

The node SHALL provide a command that prints the literal payload it would transmit, using that node's real current data. The output MUST be the transmitted content itself, not a summary or description of it.

Under a default-on design this command is the operator's primary means of verifying the privacy claim, so it SHALL be referenced directly in the first-run notice.

#### Scenario: Operator inspects the payload

- **WHEN** the operator runs the telemetry inspection command
- **THEN** the payload that would be sent is printed in full, and nothing is transmitted by that command

#### Scenario: Printed payload matches what is sent

- **WHEN** a payload is printed and a payload is transmitted from the same node state
- **THEN** the two are byte-identical

### Requirement: Operators can disable telemetry permanently and immediately

The node SHALL provide both a command and an environment variable that disable telemetry. The environment variable SHALL take precedence over any stored decision, so telemetry can be disabled without modifying node state. Disabling SHALL take effect for the current run, not only for subsequent runs.

#### Scenario: Operator disables via command

- **WHEN** the operator runs the disable command
- **THEN** the decision is persisted as disabled and no further telemetry is transmitted

#### Scenario: Environment variable overrides stored state

- **WHEN** the opt-out environment variable is set on a node whose stored decision is enabled
- **THEN** no telemetry is transmitted for that run and the stored decision is left unchanged

#### Scenario: Operator disables mid-cycle

- **WHEN** telemetry is disabled while a cycle is in progress
- **THEN** no payload is transmitted for that cycle
