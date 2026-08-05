## Purpose

Defines how collected reports are accepted, retained, and — critically — when they become trustworthy enough to act on, given that the collector must accept reports from unauthenticated senders.

## ADDED Requirements

### Requirement: Reports are accepted without sender authentication

The collector SHALL accept reports without authenticating the sender, because proving that a report originates from a genuine node would require binding it to an on-chain identity and would therefore destroy the anonymity the payload is designed to preserve.

Consequently, an individual report SHALL be treated as unverified input, and no consumer may act on a single report.

#### Scenario: Report arrives from an unrecognized sender

- **WHEN** a well-formed report arrives from an install identifier never seen before
- **THEN** it is accepted and stored as unverified

#### Scenario: Report arrives from a fabricated install identifier

- **WHEN** an arbitrary party submits reports using invented install identifiers
- **THEN** the reports are stored but do not become consumable on their own

### Requirement: Signals become consumable only above a distinct-install threshold

A signal SHALL be exposed to any consumer only after it has been reported by at least a configured number of distinct install identifiers across a configured time window. This threshold is a security control, not a tuning parameter: it is the sole mechanism distinguishing a genuine fleet-wide fault from a fabricated one.

The threshold SHALL be documented, and any change to it SHALL be treated as a security-relevant change.

#### Scenario: A single install reports a novel signal

- **WHEN** one install identifier reports a signal not seen from any other install
- **THEN** the signal is not exposed to consumers

#### Scenario: A signal reaches the threshold

- **WHEN** a signal has been reported by at least the configured number of distinct install identifiers within the window
- **THEN** the signal becomes consumable, carrying its distinct-install count

#### Scenario: One party floods reports from many fabricated identifiers

- **WHEN** a large number of reports for one signal arrive from fabricated install identifiers in a short interval
- **THEN** rate limiting and the time window constrain how quickly the threshold can be reached, and the anomaly is observable in the stored data

### Requirement: Consumers receive structured values, never free text

Any consumer of aggregated telemetry — including automated ones — SHALL receive counts, enumerated values, and identifiers drawn from closed sets. Free-text strings originating from reports MUST NOT be exposed to a consumer that can act on them.

#### Scenario: Aggregated data feeds an automated consumer

- **WHEN** aggregated telemetry is supplied to an automated process
- **THEN** it contains only counts and closed-set values, and no report-supplied free text

#### Scenario: A report contains an instruction-shaped string

- **WHEN** a report field contains text resembling an instruction
- **THEN** that text is not present in what any consumer receives

### Requirement: Retention is bounded and stated

The collector SHALL retain raw reports for a documented, bounded period and discard them afterwards. The retention period SHALL be published wherever consent is requested.

#### Scenario: Reports exceed the retention window

- **WHEN** stored raw reports pass the retention period
- **THEN** they are deleted, while previously derived aggregates may be kept

#### Scenario: Operator reads the consent prompt

- **WHEN** an operator is asked for telemetry consent
- **THEN** the stated retention period matches the collector's actual behavior

### Requirement: Ingest is rate limited

The collector SHALL rate limit submissions per install identifier and per source address, so that submission cost scales with the number of reports an adversary wishes to fabricate.

#### Scenario: One install submits far above its expected cadence

- **WHEN** an install identifier submits reports at a rate exceeding the configured limit
- **THEN** excess submissions are rejected and the rejection is recorded
