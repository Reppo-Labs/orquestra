// src/telemetry/counts.ts — the numeric half of the payload, read from data the node
// already keeps.
//
// Deliberately NO new instrumentation: every number here is a GROUP BY over the existing
// `activity` table. Adding new collection points to serve telemetry would mean the
// telemetry surface grows every time someone wants a metric, which is exactly how a
// software-health payload turns into a behavioral one.
//
// Note what is counted and what is not. Counts are keyed by (kind, status) ONLY — never
// by datanetId, podId, or token, all of which are prohibited (specs/telemetry-payload).
// "We attempted 40 votes and 3 errored" is a software-health fact. "We voted on datanet
// 3" is strategy, and strategy is competitive intelligence between operators.
import { getDb } from '../dashboard/db.js'

/** Attempted vs failed for one action kind. `failed` counts status='error' only;
 *  'refused-budget' is tracked separately because it is not a fault — it is the budget
 *  ledger working as designed, and conflating them would make a correctly-configured
 *  node look broken. */
export interface ActionCounts {
  attempted: number
  failed: number
}

export interface TelemetryCounts {
  /** Distinct cycles this node has recorded. The denominator for every other count. */
  cycles: number
  votes: ActionCounts
  mints: ActionCounts
  /** Times the ledger refused to sign because a cap would have been exceeded. A
   *  fleet-wide spike here means the shipped default caps are wrong for real nodes. */
  refusedBudget: number
  /** Actions that errored, across all kinds. */
  errors: number
}

const EMPTY: TelemetryCounts = {
  cycles: 0,
  votes: { attempted: 0, failed: 0 },
  mints: { attempted: 0, failed: 0 },
  refusedBudget: 0,
  errors: 0,
}

/** Aggregate lifetime counts for this install.
 *
 *  Best-effort: a missing or unreadable DB yields zeros rather than throwing. Telemetry
 *  must never be able to fail a cycle (specs/telemetry-payload), and a node whose DB is
 *  unavailable has larger problems than an absent count. */
export function readCounts(dataDir: string): TelemetryCounts {
  try {
    const db = getDb(dataDir)

    const cycles = (
      db.prepare('SELECT COUNT(DISTINCT cycleId) AS n FROM activity WHERE cycleId IS NOT NULL').get() as { n: number }
    ).n

    const rows = db
      .prepare('SELECT kind, status, COUNT(*) AS n FROM activity GROUP BY kind, status')
      .all() as { kind: string | null; status: string | null; n: number }[]

    const out: TelemetryCounts = {
      cycles,
      votes: { attempted: 0, failed: 0 },
      mints: { attempted: 0, failed: 0 },
      refusedBudget: 0,
      errors: 0,
    }

    for (const r of rows) {
      const n = r.n
      if (r.status === 'refused-budget') out.refusedBudget += n
      if (r.status === 'error') out.errors += n

      // 'skipped' is not an attempt — the node decided not to act. Counting it would
      // inflate the denominator and make failure rates look artificially healthy.
      const isAttempt = r.status === 'executed' || r.status === 'error'
      if (!isAttempt) continue
      const bucket = r.kind === 'vote' ? out.votes : r.kind === 'mint' ? out.mints : null
      if (bucket === null) continue
      bucket.attempted += n
      if (r.status === 'error') bucket.failed += n
    }

    return out
  } catch {
    return { ...EMPTY, votes: { ...EMPTY.votes }, mints: { ...EMPTY.mints } }
  }
}
