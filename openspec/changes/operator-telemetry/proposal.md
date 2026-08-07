## Why

Orquestra is self-hosted: every node runs on an operator's own machine, and today the project has no visibility into how that software behaves in the wild. Bugs are only known when an operator files an issue (7 issues, 2 authors to date), so the failures that matter most — the ones that make a node silently stop earning — are exactly the ones nobody reports.

This change adds anonymous software-health telemetry so the project can fix bugs for **all** operators rather than only for the nodes its maintainers happen to run.

It is deliberately scoped to software health. Node operators compete with one another for the same emissions, so strategy data (which datanets, what thresholds, what a node voted) is not merely private — it is exploitable by other operators. This change collects none of it.

**This is a bet worth naming.** The fleet is currently very small, so aggregate signal will be thin for some months. The build order below front-loads the parts that ship value without a collector existing (consent, payload, transparency), so the payload shape can be put in front of operators before infrastructure is built around it.

## What Changes

- **Anonymous install identity**: a random UUID generated on first run and stored in `DATA_DIR`. Not derived from the wallet, hostname, or any machine characteristic.
- **Enabled by default, with notice before the first transmission**: telemetry is on unless disabled, because the collector's admission threshold is expressed in distinct installs and a small opted-in fraction of a small fleet would never reach it — leaving collected data permanently unconsumable. A node MUST display the telemetry notice at least once before transmitting anything, so an operator is always informed before the first byte leaves even though they are not asked to act. Onboarding states the default plainly and offers disabling as an immediate choice.
- **Operator transparency controls**: `orquestra telemetry --show` prints the literal payload that would be sent (the bytes, not a description); `orquestra telemetry --off` and an environment variable both disable it, taking effect immediately rather than on the next run.
- **Allowlist-built payload**: the payload is assembled from an explicit field list. A field added to an internal type later is *dropped* unless it is explicitly allowlisted, so the failure mode of future code changes is omission, never disclosure. Backed by a shape test.
- **Error signatures, not error messages**: exceptions are normalized to a stable signature (error class plus top stack frames, passed through the existing `src/util/redact.ts` boundary). Free-text messages are never transmitted.
- **Collector service**: a small ingest endpoint with a versioned schema and a stated retention window.
- **Admission threshold on aggregation**: a signal becomes consumable only after it is reported by N distinct install ids across M days. The collector is unauthenticated by necessity (see design), so this threshold is the security control that makes reports trustworthy, not a tuning knob.
- **Published schema and findings**: the payload schema is documented and versioned in this repo, and aggregate findings are reported back to operators.

Not included, and explicitly out of scope: wallet addresses (in any form, including hashed), datanet and subnet ids, strategy thresholds, balances, ROI, pod content, panel transcripts, RPC URLs.

## Capabilities

### New Capabilities

- `telemetry-consent`: anonymous install identity, default-on behavior gated on a first-run notice, the onboarding disclosure, and the operator-facing controls for inspecting and disabling telemetry.
- `telemetry-payload`: the allowlisted field set, the prohibited field set, error-signature normalization, redaction, and schema versioning.
- `telemetry-ingest`: the collector's accept/reject behavior, retention, and the N-distinct-install admission threshold that gates whether collected data may be consumed.

### Modified Capabilities

None. `openspec/specs/` is currently empty; this change introduces the first capabilities.

## Impact

**New code**: a `src/telemetry/` module (install identity, allowlist payload builder, error-signature normalizer, sender) plus a separately deployed collector service and its datastore.

**Modified code**: `src/onboarding/` gains the telemetry disclosure and persists any decision; `src/index.ts` wires the telemetry client, the first-run notice, and the `telemetry` subcommand; the cycle path emits error signatures. `src/util/redact.ts` is reused unchanged as the scrubbing boundary.

**Explicitly untouched**: `src/wallet/**` (the budget-cap security boundary), the loopback-bound dashboard, and anything that reads secrets. Telemetry is emitted from data the node already computes; it introduces no new read of the environment.

**New operational surface**: a hosted collector endpoint, which becomes attacker-reachable by design. Its threat model — including the case where collected data later feeds an automated agent — is the subject of `design.md`.

**Trust surface**: this is the first time Orquestra sends any operator data anywhere. The consent wording, the `--show` output, and the published schema are part of the deliverable, not documentation to be written afterwards.
