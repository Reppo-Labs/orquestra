## Context

See `proposal.md` — Why, for motivation. Design-relevant current state:

- Nodes are self-hosted on operator machines. There is no inbound path to a node: the dashboard binds loopback by design (`DASHBOARD_HOST` defaults to `127.0.0.1`; the container's `0.0.0.0` bind is safe only because compose pins the host side to `127.0.0.1:7071:7070`) and is unauthenticated. Collection must therefore be **push-only** from the node.
- `src/util/redact.ts` already scrubs credential-shaped substrings (provider API keys in URL paths, basic-auth credentials, `?apikey=` query values) at the log, activity-log, and dashboard boundaries.
- Errors are already captured: activity rows carry `status: 'executed' | 'refused-budget' | 'error' | 'skipped'` with a redacted `detail`.
- `src/learn/reflect.ts` establishes a precedent this design extends: the reflection LLM is fed computed numbers only, never raw pod or panel text, explicitly to prevent laundering an injection into persistent state.
- Onboarding is an LLM-driven interview (`src/onboarding/agent.ts`), and `needsOnboarding(dataDir)` already gates it — a natural place to obtain consent in context.
- The fleet is currently very small. This design must produce correct behavior at low N rather than assume statistical comfort.

## Goals / Non-Goals

**Goals**

- Collection that is safe to wire into an automated consumer later, without redesign.
- A privacy boundary an operator can verify themselves rather than take on trust.
- Correct, conservative behavior while the fleet is too small for meaningful aggregates.

**Non-Goals**

- Per-operator analytics, dashboards, or comparisons between operators.
- Strategy or performance measurement of any kind. Per-node ROI tuning already exists locally in `src/learn/` and stays there.
- Real-time or streaming ingest. Cycle-cadence, best-effort delivery is sufficient.
- Authenticating that a report came from a real node — see Decisions.

## Decisions

### The collector is an untrusted input source, and is designed as one

The driving constraint is not privacy but **injection**. Telemetry is intended to eventually inform automated code changes; an unauthenticated endpoint feeding a code-writing agent is a remote prompt-injection channel that terminates in a pull request. Every decision below follows from treating ingest as hostile.

Three structural defenses, specified in `specs/telemetry-payload` and `specs/telemetry-ingest`:

1. Error **signatures**, not messages — the payload has no field wide enough to carry a sentence.
2. Distinct-install **admission threshold** — no single sender can create a work item.
3. Consumers receive **closed-set values and counts only** — never report-supplied free text.

This is the same posture `src/learn/reflect.ts` takes toward pod text, applied to a new boundary.

*Alternative considered*: sanitize free-text messages and pass them through. Rejected — sanitizing adversarial text for an LLM consumer is not a solved problem, and error messages are the highest-value injection carrier precisely because they look like legitimate debugging context.

### Unauthenticated ingest, with trust recovered statistically

Authenticity and anonymity are in direct conflict here and cannot both be bought cheaply:

| Option | Proves node-ness | Cost |
|---|---|---|
| Sign with operator wallet | yes | de-anonymizes completely — the address links to full on-chain financial history |
| Include a recent on-chain action hash | yes | same linkage |
| Proof-of-work | no | raises attacker cost only |
| Unauthenticated + distinct-install threshold | statistically | accepted |

We accept unauthenticated ingest and recover trust through the threshold. The consequence is stated in `specs/telemetry-ingest`: **the threshold is the security control**, so lowering it to "get signal faster" while the fleet is small directly removes the only barrier between a `curl` command and an automated change. If low N makes the threshold impractical, the correct response is to leave telemetry unconsumed, not to lower it.

### Allowlist construction, backed by a shape test

The payload is built by naming each field. The reason is specific to this project's trajectory: an automated improvement loop will eventually modify the code that produces its own telemetry. Under a denylist, a future field is transmitted by default and disclosure is one careless change away; under an allowlist, the failure mode is a missing field, which is observable and harmless.

The shape test is not incidental — it is what makes the allowlist hold under automated modification. The payload builder should also be treated as a protected path by any future automated change process.

*Alternative considered*: serialize `Snapshot` and strip prohibited fields. Rejected — `Snapshot` already carries balances, budget spend, and per-datanet economics, all of which are prohibited. Its shape is driven by dashboard needs and will keep changing.

### Wallet addresses are excluded outright, not hashed

Hashing is normally adequate pseudonymization. It is not here: the set of node wallet addresses is small and fully enumerable from public chain data, so any hash is reversible by brute-forcing the known address set. Excluded entirely, with no derived form.

### Default-on, gated on a first-run notice

Opt-in was the initial choice, on the reasoning that operators are pseudonymous and the node holds a wallet key. It was rejected for a structural reason that only became visible once the ingest design was settled:

**Opt-in is incompatible with the admission threshold.** The threshold is expressed in *distinct installs* (`specs/telemetry-ingest`). Typical opt-in participation in developer tooling runs in the low single digits to ~10%. Against a fleet of this size, that yields a population where no signal ever reaches the threshold — so data would be collected, stored, retained, and never legitimately consumable. That is the worst of both worlds: all of the privacy surface, none of the benefit.

Default-on is what makes the threshold a real control rather than a permanent blocker. Since the threshold is the *only* defense against fabricated reports, a design that cannot reach it is not a safer design — it is an unusable one that would eventually be "fixed" by lowering the threshold, which is the actually dangerous outcome.

Two conditions make default-on defensible, and both are enforced in the specs:

1. **The payload contains no personal or identifying data.** No wallet address in any form, no strategy, no datanets, no free text. The install id is random and non-derived. This is what separates this from telemetry that would warrant consent, and `specs/telemetry-consent` states that if it ever ceases to hold, the default must be revisited *before* the payload changes.
2. **Notice precedes the first transmission.** A node must display the telemetry notice at least once, and record that it did, before sending anything — including on upgrade from a version that predates telemetry. The operator is always informed before the first byte leaves, even though they are not asked to act. This is the difference between default-on and covert.

*Consequence to accept*: the payload's prohibited-field list is now the entire privacy defense, and it applies to every operator by default rather than to a consenting minority. The allowlist and its shape test move from prudent to load-bearing.

*Alternative considered*: opt-in with a lowered threshold to compensate. Rejected outright — that trades the security control for participation, which inverts the priority. If the fleet is too small for the threshold, the correct behavior is to leave telemetry unconsumed, not to weaken the gate.

### Self-hosted collector rather than a third-party service

Sentry is purpose-built for crash aggregation, but groups on error *messages*, reintroducing exactly the free-text channel this design removes, and places operator data with a third party. A small self-hosted ingest service keeps the admission threshold and the no-free-text rule enforceable in our own query layer, where they can be tested.

*Trade-off*: an operational surface to run and secure.

### AWS: API Gateway HTTP API -> Lambda -> DynamoDB with TTL

Chosen over a container-plus-Postgres deployment for one specific reason: **retention becomes a table property instead of a job**.

The spec requires raw reports to be deleted after a documented period, and `docs/telemetry.md` states that period to operators. A cron-driven delete can fail silently, and its failure mode is holding operator data for years while still promising ninety days — a broken privacy claim rather than a broken feature. DynamoDB TTL makes expiry an attribute on the item, so the guarantee does not depend on a scheduled job succeeding.

API Gateway's native throttling also covers the per-source rate limit (`specs/telemetry-ingest`) without application code.

*Cost accepted*: DynamoDB has no `COUNT(DISTINCT)`, so the distinct-install threshold is computed by a scheduled Lambda over a bounded window rather than by a single query. At the fleet sizes this is designed for, the window is small enough that this is unremarkable. If aggregation later outgrows it, S3 + Athena is the escape hatch and the ingest half is unchanged.

*Alternatives considered*: Fargate + RDS is closest to "a small service" and makes aggregation trivial SQL, but is always-on cost for a workload idle almost all the time, and puts retention back on a cron. S3 + Athena is cheapest and keeps SQL aggregation, but S3 lifecycle expiry is coarser and the raw store is less convenient to rate-limit against.

*Note on cold starts*: normally the argument against Lambda for an API. It is not one here — transmission is fire-and-forget with a short timeout and no retry (`specs/telemetry-payload`), and the admission threshold already treats individual reports as lossy and untrustworthy. A cold start that overruns the timeout costs one report from one node.

### Non-blocking, best-effort delivery

Nodes earn only by voting and minting on-chain. Telemetry must never be able to delay or fail a cycle, so transmission is fire-and-forget with contained failures (`specs/telemetry-payload`). Delivery loss is acceptable; aggregates tolerate it, and the threshold is expressed in distinct installs rather than report counts.

## Risks / Trade-offs

- **Fabricated reports manufacture work items** → distinct-install threshold, rate limiting per install and source address, bounded window; consumers see counts only.
- **Fleet still too small to cross the threshold even at default-on** → accepted. Telemetry stays unconsumed until the fleet grows. Do not compensate by lowering the threshold; the fleet-behavior signal available from public chain data is the intended near-term substitute.
- **A future code change leaks a new field** → allowlist plus shape test; payload builder treated as a protected path. Under default-on this is the highest-severity risk in the design: a leaked field reaches every operator immediately, not a consenting minority. Treat allowlist changes as security-relevant review.
- **Notice wording misrepresents behavior** → the inspection command prints the real payload from real node state, so a mismatch is operator-detectable; the retention period stated in the notice must match collector behavior.
- **Operators perceive default-on telemetry as surveillance** → notice before first transmission, published schema, byte-exact inspection, immediate opt-out by env var with no state change, aggregate findings published back. The reputational failure mode here is a first transmission an operator did not know about; the notice gate exists specifically to make that impossible.
- **Upgrade path silently begins transmitting** → nodes upgrading from a pre-telemetry version are treated as never having seen the notice, so the first post-upgrade run shows the notice and transmits nothing.
- **Collector becomes an operational liability** → bounded retention limits both cost and breach impact; node behavior is unaffected if it is taken offline entirely.
- **Error signatures are too coarse or too fine** → too fine and identical faults never reach the threshold; too coarse and distinct bugs merge. Normalization needs iteration against real data, and `schemaVersion` allows changing it without breaking stored history.

## Migration Plan

The capability is new and default-on, so existing nodes **do** change behavior on upgrade. The notice gate is the migration control: an upgraded node is treated as never having displayed the notice, so its first post-upgrade run shows the notice and transmits nothing. Transmission begins on the run after that.

Rollout order deliberately front-loads the parts that need no collector, so payload shape can be reviewed by operators before infrastructure is committed to it:

1. Install identity, consent capture, inspection and opt-out commands — no network.
2. Payload builder, allowlist, shape test, published schema — no network.
3. Collector, retention, rate limiting.
4. Aggregation with the admission threshold.
5. Only then, expose aggregates to any consumer.

**Rollback**: the opt-out environment variable disables transmission fleet-wide without a release. Taking the collector offline is safe by construction, since delivery is best-effort.

## Open Questions

- Concrete threshold values (distinct installs, window length) and the retention period. Deferrable: the specs require them to exist, be documented, and be treated as security-relevant, and choosing numbers does not change the approach or the task breakdown. They should be set before step 5, informed by the actual install count.
- Whether adapter identifiers and LLM provider names are transmitted. Both sit on the feature-usage side of the feature-usage / strategy line and are useful for maintenance prioritization, but operators will read the payload and may disagree. Deferrable to the schema review in step 2; it is an allowlist entry either way.
- Error-signature normalization depth (how many stack frames, how paths are normalized). Requires real data to tune; `schemaVersion` makes it revisable.
