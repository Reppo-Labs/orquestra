## 1. Install identity and consent state

- [x] 1.1 Add `src/telemetry/identity.ts`: generate a random install id on first run, persist under `DATA_DIR`, return the existing one on subsequent runs
- [x] 1.2 Add `src/telemetry/consent.ts`: read/write the telemetry decision in `DATA_DIR`, defaulting to enabled when missing or corrupt, and separately record whether the first-run notice has been displayed
- [x] 1.3 Make the opt-out environment variable take precedence over stored state without mutating it, effective for the current run
- [x] 1.4 Implement the notice gate: no transmission until the notice has been displayed and that fact recorded; a node with no notice record (including one upgraded from a pre-telemetry version) shows the notice and transmits nothing that run
- [x] 1.5 Tests for 1.1–1.4: corrupt-state-defaults-to-enabled-and-re-notices, notice-gate blocks first-run transmission, upgrade path re-notices, id stability across restarts, two `DATA_DIR`s yield different ids

## 2. Payload builder

- [x] 2.1 Declare the allowlisted field set as a single explicit, exported constant
- [x] 2.2 Add `src/telemetry/payload.ts` that constructs the payload by naming each allowlisted field; include `schemaVersion` and production timestamp
- [x] 2.3 Add `src/telemetry/signature.ts`: normalize an exception to `{errorClass, frames[]}`, routing all content through `src/util/redact.ts`
- [x] 2.4 Source counts from existing activity data (cycles run; votes and mints attempted vs failed; `refused-budget` occurrences) without introducing new reads
- [x] 2.5 Shape test that fails when the payload contains any field absent from the allowlist
- [x] 2.6 Prohibited-content tests: no wallet address in any form, no datanet or subnet id, no strategy threshold, no balance or ROI, no pod or panel text, no RPC URL
- [x] 2.7 Test that an error embedding a credentialled RPC URL produces a signature containing no credential material
- [x] 2.8 Test that the same fault on two differently-configured nodes yields an identical signature

## 3. Operator-facing surface

- [x] 3.1 Add the `telemetry` subcommand to `src/index.ts` with `--show` and `--off`
- [x] 3.2 `--show` prints the literal payload built from that node's real current state and transmits nothing
- [x] 3.3 Test that `--show` output is byte-identical to what would be transmitted from the same node state
- [x] 3.4 Write the first-run notice text: what is collected, what is never collected, how to inspect, how to disable, retention period
- [x] 3.5 Add the telemetry disclosure to the onboarding interview: state that it is enabled, and offer disabling as an immediate in-interview choice
- [x] 3.6 Persist any onboarding decision via the consent module; on re-run, present the prior decision as default and preserve it when unchanged
- [x] 3.7 Tests: disabling during onboarding suppresses transmission for that same run; re-run preserves the prior decision

## 4. Published schema

- [x] 4.1 Write `docs/telemetry.md`: the exact field list, the prohibited list, retention, how to inspect and opt out
- [x] 4.2 Review the field list against the design's open question on adapter ids and LLM provider names; record the decision in the doc
- [x] 4.3 Test asserting the documented field list matches the allowlist constant, so the doc cannot silently drift

## 5. Sender

- [x] 5.1 Add `src/telemetry/send.ts`: fire-and-forget transmission, contained failures, no retry storm
- [x] 5.2 Wire transmission into the cycle path, gated on both the notice record and the enabled state; a disabled node makes no network call
- [x] 5.3 Test that an unreachable collector leaves the cycle unaffected
- [x] 5.4 Test that payload construction throwing is contained and transmits nothing
- [x] 5.5 Test that a disabled node performs no collector network call
- [x] 5.6 Test that a node which has not yet displayed the notice performs no collector network call

## 6. Collector service (AWS: API Gateway HTTP API -> Lambda -> DynamoDB)

- [x] 6.1 Add `collector/` with the ingest Lambda handler: accept POST without sender authentication, return 202 on accept
- [x] 6.2 Validate `schemaVersion` and payload shape; reject malformed reports with 400 and record the rejection
- [x] 6.3 Per-install rate limiting in the handler; per-source throttling on the API Gateway stage
- [x] 6.4 DynamoDB table with a TTL attribute set from `RETENTION_DAYS`, so expiry is a table property rather than a cron
- [x] 6.5 CDK stack wiring API Gateway, Lambda, and the table, with throttling and least-privilege IAM
- [x] 6.6 Handler tests: accept, reject-malformed, reject-unknown-schema, TTL is set, rate limit trips
- [x] 6.7 Test asserting the collector's retention matches `RETENTION_DAYS` and what `docs/telemetry.md` states
- [x] 6.8 Deploy (operator-run `cdk deploy`) and record the endpoint URL — deployed 2026-08-11 to account 484907511683 us-west-2, stack `OrquestraTelemetryCollector`; endpoint `https://njivst0b99.execute-api.us-west-2.amazonaws.com/v1/reports` (route-path bug fixed in PR #187: stage name + route path both carried `v1`, serving `/v1/v1/reports`)

## 7. Aggregation and admission threshold

- [x] 7.1 Choose and document the distinct-install threshold and window; record them as security-relevant configuration
- [x] 7.2 Implement aggregation that exposes a signal only above the distinct-install threshold within the window
- [x] 7.3 Ensure exposed aggregates carry only counts and closed-set values, with no report-supplied free text
- [x] 7.4 Test that a signal from a single install is never exposed
- [x] 7.5 Test that instruction-shaped text in a report is absent from consumer-facing output
- [x] 7.6 Test that flooding from many fabricated install ids is constrained by rate limiting and the window

## 8. Verification

- [x] 8.1 Run `npm run typecheck` and `npm test`
- [x] 8.2 Run a real node end to end with telemetry enabled; confirm via `--show` and collector state that the transmitted payload matches the documented schema — 2026-08-11: both live nodes (Base + Robinhood) reported; DynamoDB rows match schema v1 (bucketed counts, empty errorSignatures, no free text) with TTL ≈90 days
- [ ] 8.3 Run a real node with telemetry disabled; confirm no collector network call occurs
- [ ] 8.4 Run a fresh node and confirm the first run displays the notice and transmits nothing
- [x] 8.5 Confirm no consumer is wired to aggregates yet — exposure is a later change, gated on a real install count — confirmed at deploy: the hourly aggregate Lambda publishes to no consumer, and `MIN_DISTINCT_INSTALLS = 3` exceeds the current 2-install fleet
