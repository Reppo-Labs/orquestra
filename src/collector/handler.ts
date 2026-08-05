// src/collector/handler.ts — the ingest decision, independent of AWS.
//
// The Lambda entry point under collector/ is a thin shell around this: it reads the HTTP
// event, calls handleIngest, and writes the result. Keeping the decision here means the
// security-critical path is covered by the node's own test suite rather than by whatever
// testing an infrastructure package happens to have.
import { validateReport, type RejectReason, type StoredReport } from './validate.js'
import { checkRate, type InstallActivity } from './rateLimit.js'
import { RETENTION_DAYS } from './config.js'

export interface IngestRequest {
  body: string
  /** Prior accepted-report times for this install, if the adapter could look them up.
   *  Absent means "unknown" and is treated as no prior activity — the per-source
   *  throttle at the gateway is the backstop when this is unavailable. */
  activity?: InstallActivity
  nowMs?: number
}

export interface IngestResponse {
  status: 202 | 400 | 429
  /** Deliberately coarse. The precise reason goes to our metrics, never to the sender:
   *  a detailed validation error is a free oracle for probing what the collector accepts. */
  body: { ok: boolean }
  /** For the collector's own metrics. Not transmitted to the sender. */
  rejectReason?: RejectReason | 'rate-limited'
  /** The row to persist, present only on 202. */
  store?: StoredReport & { expiresAt: number; receivedAt: string }
}

/** Seconds-since-epoch at which DynamoDB should expire this row.
 *
 *  Computed from RETENTION_DAYS — the same constant the first-run notice and
 *  docs/telemetry.md quote — so the retention an operator was promised and the retention
 *  the table enforces cannot diverge. DynamoDB TTL expects epoch SECONDS, not ms; getting
 *  that wrong by a factor of 1000 would set expiry ~50,000 years out and silently keep
 *  every report forever, which is precisely the broken-privacy-claim failure this design
 *  chose TTL to avoid. */
export function expiresAtSeconds(nowMs: number, retentionDays: number = RETENTION_DAYS): number {
  return Math.floor(nowMs / 1000) + retentionDays * 24 * 60 * 60
}

/** Decide the fate of one incoming report. Pure. */
export function handleIngest(req: IngestRequest): IngestResponse {
  const nowMs = req.nowMs ?? Date.now()

  const validation = validateReport(req.body)
  if (!validation.ok) {
    return { status: 400, body: { ok: false }, rejectReason: validation.reason }
  }

  // Rate limiting AFTER validation, so a malformed flood is rejected on the cheaper path
  // and never consumes an install's hourly allowance.
  const rate = checkRate(req.activity ?? { recentMs: [] }, nowMs)
  if (!rate.allowed) {
    return { status: 429, body: { ok: false }, rejectReason: 'rate-limited' }
  }

  return {
    status: 202,
    body: { ok: true },
    store: {
      ...validation.report,
      // receivedAt is OURS. Windowing and rate limiting must not depend on `ts`, which
      // the sender controls and can lie about.
      receivedAt: new Date(nowMs).toISOString(),
      expiresAt: expiresAtSeconds(nowMs),
    },
  }
}
