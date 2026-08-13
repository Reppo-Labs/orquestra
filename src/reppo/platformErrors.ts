// src/reppo/platformErrors.ts
// Durable record of failed calls to the Reppo PLATFORM REST API — the indexing surface
// that makes an on-chain action visible in the webapp (see platformApi.ts).
//
// Why this exists at all: every platform call in the node is deliberately non-fatal,
// because the chain is the source of truth and a failed POST must never invalidate a
// landed transaction. That is right — but it was implemented as "log to stderr and move
// on", which in a container means the evidence is gone by the time an operator notices.
// Two live reports came in as "my pods don't show up" and "my votes don't show up" with
// nothing on the node to investigate: the mint said executed, the vote said executed, and
// the platform's own response body had never been written down anywhere.
//
// So: still non-fatal, still never blocking a cycle — but the platform's answer is kept
// verbatim (redacted) so the failure is diagnosable after the fact.
import { getDb } from '../dashboard/db.js'
import { redactSecrets } from '../util/redact.js'

/** Which node action failed to register. 'mint' covers the CLI's Phase-2 metadata POST;
 *  'vote' covers registerVoteOnPlatform. */
export type PlatformErrorKind = 'mint' | 'vote'

export interface PlatformErrorEntry {
  ts: string
  cycleId?: string
  kind: PlatformErrorKind
  datanetId?: string
  /** on-chain pod token id (NOT the platform cuid) — the id the node actually holds. */
  podId?: string
  txHash?: string
  /** where in the flow it broke: 'ipfs-pin' | 'register' (mint Phase 2), or
   *  'resolve-pod' when the tokenId could not be mapped to a platform pod at all. */
  stage?: string
  /** platform HTTP status, when the call completed. Absent ⇒ it never reached the API. */
  httpStatus?: number
  /** structured error code from the CLI or our own classification. */
  code?: string
  /** the platform's own response body / error text. The point of the whole table. */
  message: string
}

/** Persist one failed platform call. NEVER throws: this runs on the failure path of an
 *  already-successful on-chain action, so a storage problem must not escalate into
 *  aborting a cycle. A write failure degrades to stderr, which is where we were before. */
export function recordPlatformError(dataDir: string, entry: PlatformErrorEntry): void {
  try {
    getDb(dataDir)
      .prepare(
        `INSERT INTO platform_errors (ts, cycleId, kind, datanetId, podId, txHash, stage, httpStatus, code, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.ts,
        entry.cycleId ?? null,
        entry.kind,
        entry.datanetId ?? null,
        entry.podId ?? null,
        entry.txHash ?? null,
        entry.stage ?? null,
        entry.httpStatus ?? null,
        entry.code ?? null,
        // Redact on WRITE, like activityLog: platform error bodies echo request URLs,
        // and an --rpc-url carries an API key.
        redactSecrets(entry.message),
      )
  } catch (e) {
    console.error(`orquestra: could not persist platform error (non-fatal): ${(e as Error).message}`)
  }
}

/** Most recent `limit` failures, newest-first. Missing DB → []. */
export function readPlatformErrors(dataDir: string, opts: { limit: number }): PlatformErrorEntry[] {
  try {
    const rows = getDb(dataDir)
      .prepare('SELECT * FROM platform_errors ORDER BY id DESC LIMIT ?')
      .all(opts.limit) as Record<string, unknown>[]
    return rows.map((r) => {
      const e: PlatformErrorEntry = {
        ts: String(r.ts), kind: r.kind as PlatformErrorKind, message: String(r.message),
      }
      for (const k of ['cycleId', 'datanetId', 'podId', 'txHash', 'stage', 'code'] as const) {
        if (r[k] !== null && r[k] !== undefined) e[k] = String(r[k])
      }
      if (r.httpStatus !== null && r.httpStatus !== undefined) e.httpStatus = Number(r.httpStatus)
      return e
    })
  } catch {
    return []
  }
}

/** How many failures were recorded since `sinceIso` — the number a health panel shows so
 *  an operator learns about invisible pods/votes without going looking. Missing DB → 0. */
export function countPlatformErrorsSince(dataDir: string, sinceIso: string): number {
  try {
    const row = getDb(dataDir)
      .prepare('SELECT COUNT(*) AS n FROM platform_errors WHERE ts >= ?')
      .get(sinceIso) as { n: number }
    return row.n
  } catch {
    return 0
  }
}
