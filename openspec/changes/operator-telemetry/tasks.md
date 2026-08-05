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

## 6. Collector service

- [ ] 6.1 Stand up the ingest service and datastore; accept reports without sender authentication
- [ ] 6.2 Validate `schemaVersion` and reject malformed reports; record rejections
- [ ] 6.3 Rate limit per install id and per source address
- [ ] 6.4 Implement bounded retention of raw reports with scheduled deletion; keep derived aggregates
- [ ] 6.5 Verify the deployed retention period matches what the first-run notice and `docs/telemetry.md` state

## 7. Aggregation and admission threshold

- [ ] 7.1 Choose and document the distinct-install threshold and window; record them as security-relevant configuration
- [ ] 7.2 Implement aggregation that exposes a signal only above the distinct-install threshold within the window
- [ ] 7.3 Ensure exposed aggregates carry only counts and closed-set values, with no report-supplied free text
- [ ] 7.4 Test that a signal from a single install is never exposed
- [ ] 7.5 Test that instruction-shaped text in a report is absent from consumer-facing output
- [ ] 7.6 Test that flooding from many fabricated install ids is constrained by rate limiting and the window

## 8. Verification

- [x] 8.1 Run `npm run typecheck` and `npm test`
- [ ] 8.2 Run a real node end to end with telemetry enabled; confirm via `--show` and collector state that the transmitted payload matches the documented schema
- [ ] 8.3 Run a real node with telemetry disabled; confirm no collector network call occurs
- [ ] 8.4 Run a fresh node and confirm the first run displays the notice and transmits nothing
- [ ] 8.5 Confirm no consumer is wired to aggregates yet — exposure is a later change, gated on a real install count
