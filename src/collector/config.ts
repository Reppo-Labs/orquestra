// src/collector/config.ts — the collector's security-relevant constants.
//
// These live in the node's source tree ON PURPOSE. The collector validates against the
// very same SCHEMA_VERSION the node transmits, so the two cannot drift into a state where
// the fleet is sending a shape the collector silently mis-parses. The AWS adapter under
// collector/ imports these; it does not redefine them.
import { RETENTION_DAYS } from '../telemetry/notice.js'

export { RETENTION_DAYS }

/** Distinct installs that must report a signal before it may be exposed to any consumer.
 *
 *  THIS IS A SECURITY CONTROL, NOT A TUNING KNOB (specs/telemetry-ingest). The collector
 *  accepts reports without authentication, so this threshold is the only thing separating
 *  a genuine fleet-wide fault from one an attacker fabricated.
 *
 *  Be honest about its strength: at a value a small fleet can actually reach, this is weak
 *  against a determined attacker. Three install ids are three calls to randomUUID(); the
 *  cost imposed is the per-install and per-source rate limits, not the threshold itself.
 *  What makes that acceptable today is that NOTHING CONSUMES AGGREGATES YET (task 8.5) and
 *  consumers receive counts only, never report-supplied text.
 *
 *  Raise this as the fleet grows. The failure mode to avoid is the opposite reflex —
 *  lowering it because signals are not coming through, which trades the control away for
 *  throughput and is exactly the change this comment exists to make someone argue for
 *  out loud. */
export const MIN_DISTINCT_INSTALLS = 3

/** Rolling window over which distinct installs are counted. Bounds how long an attacker
 *  has to accumulate fabricated reports toward the threshold, and keeps a long-fixed bug
 *  from resurfacing forever. */
export const WINDOW_DAYS = 7

/** Max accepted reports per install id per hour. A healthy node sends roughly once per
 *  cycle, so anything near this is either misconfigured or synthetic. */
export const MAX_REPORTS_PER_INSTALL_PER_HOUR = 12

/** Payload bytes above which a report is rejected outright. The real payload is well
 *  under a kilobyte; this exists so a malformed or hostile body cannot become a storage
 *  or parsing cost. */
export const MAX_PAYLOAD_BYTES = 16 * 1024
