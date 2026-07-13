// src/dashboard/activityLog.ts
// Activity history store, backed by SQLite (node:sqlite, built into Node >=22.5 —
// zero extra deps). Replaces the append-only JSONL: reads are indexed (newest-first
// LIMIT, or a since-window) instead of re-parsing the whole file each dashboard poll.
// The public API (appendActivity / readActivity) is unchanged; on first open an
// existing activity-log.jsonl is imported once so history carries over.
import { readFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../util/redact.js'
import type { PanelTranscript } from '../panel/types.js'
import { getDb, type SqliteDb } from './db.js'
import { readMintReppoFee } from '../reppo/mintFee.js'

export interface ActivityEntry {
  ts: string
  cycleId: string
  // 'grant' = a one-time subnet access grant breadcrumb (records the fee paid, e.g.
  //  "granted access — paid 50 EXY"). Distinct from 'skip' so a successful grant is
  //  NOT counted as idleness/skip in buildHealth. The `kind` column is plain TEXT, so
  //  this needs no DDL change. (db.ts activity.kind has no CHECK constraint.)
  // 'info' = HISTORICAL ONLY — a per-cycle datanet-economics breadcrumb (emission
  //  yield) written by v0.3.5 nodes; no longer produced (yield is state and now rides
  //  the snapshot only — see runCycle's stderr-only note). Kept in the union so old DB
  //  rows still type/render; excluded from ALL health aggregation (buildHealth).
  kind: 'vote' | 'mint' | 'claim' | 'skip' | 'grant' | 'stake' | 'info'
  datanetId: string
  podId?: string
  direction?: 'up' | 'down'
  conviction?: number
  reason?: string
  canonicalKey?: string
  podName?: string
  epoch?: number
  reppoClaimed?: number
  /** non-REPPO emission token claimed (e.g. 'LBM') + amount in human units, when a claim
   *  paid a datanet's native token. Absent for plain REPPO claims. */
  claimedTokenSymbol?: string
  claimedTokenAmount?: number
  /** REPPO fee paid for this mint (reconciled actual, or MINT_REPPO_FALLBACK when unknown).
   *  Only present on kind='mint' + status='executed'. Used for lifetime PnL. */
  reppoSpent?: number
  status: 'executed' | 'refused-budget' | 'error' | 'skipped'
  txHash?: string
  gasEth?: number
  detail?: string
  /** multi-agent panel transcript when a panel produced this vote/mint (see src/panel). */
  panel?: PanelTranscript
}

const LEGACY = 'activity-log.jsonl'

// ── redaction (defense-in-depth: error text can carry --rpc-url keys; panel text
//    is LLM-generated from untrusted pod data) — applied on write. ──────────────
function redactDeep(v: unknown): unknown {
  if (typeof v === 'string') return redactSecrets(v)
  if (Array.isArray(v)) return v.map(redactDeep)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, redactDeep(val)]))
  }
  return v
}

function redactEntry(entry: ActivityEntry): ActivityEntry {
  return {
    ...entry,
    ...(entry.detail !== undefined ? { detail: redactSecrets(entry.detail) } : {}),
    ...(entry.reason !== undefined ? { reason: redactSecrets(entry.reason) } : {}),
    ...(entry.panel !== undefined ? { panel: redactDeep(entry.panel) as PanelTranscript } : {}),
  }
}

const COLUMNS = [
  'ts', 'cycleId', 'kind', 'datanetId', 'podId', 'direction', 'conviction', 'reason',
  'canonicalKey', 'podName', 'epoch', 'reppoClaimed', 'status', 'txHash', 'gasEth', 'detail', 'panel',
  'claimedTokenSymbol', 'claimedTokenAmount', 'reppoSpent',
] as const

// The `activity` table is owned by db.ts. We run the one-time JSONL import on first
// touch per dataDir; the import itself is also guarded by a table-empty check, so it
// stays a no-op across restarts.
const imported = new Set<string>()
function conn(dataDir: string): SqliteDb {
  const d = getDb(dataDir)
  if (!imported.has(dataDir)) {
    importLegacyJsonl(d, dataDir)
    imported.add(dataDir)
  }
  return d
}

/** One-time import of a pre-existing activity-log.jsonl (+ .old) into an empty DB,
 *  preserving history. The JSONL is renamed to *.imported afterwards (kept, not
 *  deleted). No-op once the table has rows. */
function importLegacyJsonl(d: SqliteDb, dataDir: string): void {
  const count = (d.prepare('SELECT COUNT(*) AS n FROM activity').get() as { n: number }).n
  if (count > 0) return
  const live = join(dataDir, LEGACY)
  const old = join(dataDir, LEGACY + '.old')
  if (!existsSync(live) && !existsSync(old)) return
  const parse = (p: string): ActivityEntry[] => {
    if (!existsSync(p)) return []
    const out: ActivityEntry[] = []
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      if (line.trim() === '') continue
      try { out.push(JSON.parse(line) as ActivityEntry) } catch { /* skip torn line */ }
    }
    return out
  }
  // .old is older than live; insert oldest-first so id order tracks chronology.
  const rows = [...parse(old), ...parse(live)]
  d.exec('BEGIN')
  try {
    for (const e of rows) insert(d, e)
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
  if (existsSync(live)) renameSync(live, live + '.imported')
  if (existsSync(old)) renameSync(old, old + '.imported')
}

const PLACEHOLDERS = COLUMNS.map(() => '?').join(', ')
function insert(d: SqliteDb, entry: ActivityEntry): void {
  const e = redactEntry(entry)
  const vals: (string | number | null)[] = [
    e.ts, e.cycleId ?? null, e.kind ?? null, e.datanetId ?? null, e.podId ?? null,
    e.direction ?? null, e.conviction ?? null, e.reason ?? null, e.canonicalKey ?? null, e.podName ?? null,
    e.epoch ?? null, e.reppoClaimed ?? null, e.status ?? null, e.txHash ?? null, e.gasEth ?? null,
    e.detail ?? null, e.panel ? JSON.stringify(e.panel) : null,
    e.claimedTokenSymbol ?? null, e.claimedTokenAmount ?? null, e.reppoSpent ?? null,
  ]
  d.prepare(`INSERT INTO activity (${COLUMNS.join(', ')}) VALUES (${PLACEHOLDERS})`).run(...vals)
}

type Row = Record<string, string | number | null>

/** Reconstruct an ActivityEntry from a DB row, dropping null columns so the shape
 *  matches what callers expect (optional fields absent, not undefined-valued). */
function rowToEntry(r: Row): ActivityEntry {
  const e: Record<string, unknown> = {}
  for (const c of COLUMNS) {
    const v = r[c]
    if (v === null || v === undefined) continue
    if (c === 'panel') { try { e.panel = JSON.parse(v as string) } catch { /* skip */ } }
    else e[c] = v
  }
  return e as unknown as ActivityEntry
}

/** Append one activity entry. Redacts secrets before persisting. Never rotates —
 *  SQLite handles growth; reads are indexed. */
export function appendActivity(dataDir: string, entry: ActivityEntry): void {
  insert(conn(dataDir), entry)
}

/** Most recent `limit` entries, newest-first. Missing DB → []. */
export function readActivity(dataDir: string, opts: { limit: number }): ActivityEntry[] {
  const rows = conn(dataDir).prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(opts.limit) as Row[]
  return rows.map(rowToEntry)
}

/** Total REPPO from every executed claim in the log, summed in SQL (unbounded).
 *  PnL must use this rather than summing a `readActivity({ limit })` slice — a
 *  capped read drops old claims while cumulative mint spend is never truncated,
 *  making net REPPO read falsely negative. Missing DB → 0. */
export function sumClaimedReppo(dataDir: string): number {
  const row = conn(dataDir)
    .prepare("SELECT COALESCE(SUM(reppoClaimed), 0) AS total FROM activity WHERE kind = 'claim' AND status = 'executed'")
    .get() as { total: number }
  return row.total
}

/** Lifetime REPPO spent on mints (unbounded sum of reppoSpent on executed mints).
 *  Parallel to sumClaimedReppo — both must be lifetime to keep netReppo accurate
 *  across budget-horizon resets. Missing DB or pre-migration rows (reppoSpent=NULL) → 0. */
export function sumMintReppoSpent(dataDir: string): number {
  const row = conn(dataDir)
    .prepare("SELECT COALESCE(SUM(reppoSpent), 0) AS total FROM activity WHERE kind = 'mint' AND status = 'executed'")
    .get() as { total: number }
  return row.total
}

/** Lifetime REPPO in/out + action counts per datanet, aggregated in SQL. Same
 *  lifetime-sum rationale as sumClaimedReppo/sumMintReppoSpent (a capped slice would
 *  truncate old claims while mint spend stays cumulative, so per-datanet ROI would read
 *  falsely negative as the log grows). Rows with no datanetId (wallet-global 'stake'
 *  breadcrumbs) are excluded. Consumed by src/dashboard/datanetPnl.ts. */
export interface DatanetTotals {
  datanetId: string
  reppoSpent: number
  reppoEarned: number
  votesCast: number
  mintsExecuted: number
}
export function readDatanetTotals(dataDir: string): DatanetTotals[] {
  return conn(dataDir).prepare(`
    SELECT datanetId,
      COALESCE(SUM(CASE WHEN kind = 'mint'  AND status = 'executed' THEN reppoSpent   ELSE 0 END), 0) AS reppoSpent,
      COALESCE(SUM(CASE WHEN kind = 'claim' AND status = 'executed' THEN reppoClaimed ELSE 0 END), 0) AS reppoEarned,
      COALESCE(SUM(CASE WHEN kind = 'vote'  AND status = 'executed' THEN 1 ELSE 0 END), 0) AS votesCast,
      COALESCE(SUM(CASE WHEN kind = 'mint'  AND status = 'executed' THEN 1 ELSE 0 END), 0) AS mintsExecuted
    FROM activity
    WHERE datanetId IS NOT NULL AND datanetId <> ''
    GROUP BY datanetId
  `).all() as unknown as DatanetTotals[]
}

/** Entries at or after `sinceMs` (epoch millis), newest-first. Indexed on ts, so
 *  the dashboard health window doesn't re-read the whole history each poll. */
export function readActivitySince(dataDir: string, sinceMs: number): ActivityEntry[] {
  const since = new Date(sinceMs).toISOString()
  const rows = conn(dataDir).prepare('SELECT * FROM activity WHERE ts >= ? ORDER BY id DESC').all(since) as Row[]
  return rows.map(rowToEntry)
}

/** Back-fill datanetId on historical executed claim rows recorded as unattributed.
 *  The on-chain emissions scan returns datanetId='' and `reppo mint-pod --json`
 *  (CLI ≤0.12.x) returns no podId, so the runtime enrichment could not map OUR OWN
 *  pods' owner claims to their datanet — per-datanet earn views under-count while the
 *  claimed total is correct. Resolution mirrors the runtime fix: vote/mint activity
 *  first, then datanet membership via `listDatanetPodIds` (one fetch per configured
 *  datanet, only when something is unresolved). Unresolvable rows stay '' — never
 *  guessed. Runs once at startup, fire-and-forget; safe to re-run. */
export async function backfillClaimDatanets(
  dataDir: string,
  configuredDatanets: string[],
  listDatanetPodIds: (datanetId: string) => Promise<string[]>,
): Promise<void> {
  const db = conn(dataDir)
  const rows = db.prepare(
    "SELECT id, podId FROM activity WHERE kind='claim' AND status='executed' AND (datanetId IS NULL OR datanetId='') AND podId IS NOT NULL AND podId != ''"
  ).all() as { id: number; podId: string }[]
  if (rows.length === 0) return
  const podDatanet = new Map<string, string>()
  const acts = db.prepare(
    "SELECT DISTINCT podId, datanetId FROM activity WHERE kind IN ('vote','mint') AND podId IS NOT NULL AND podId != '' AND datanetId IS NOT NULL AND datanetId != ''"
  ).all() as { podId: string; datanetId: string }[]
  for (const a of acts) if (!podDatanet.has(a.podId)) podDatanet.set(a.podId, a.datanetId)
  // Membership sweep with early exit. A permanently unresolvable row (pod on a removed
  // or never-configured datanet) does re-trigger this sweep on every boot — a conscious
  // trade-off: the cost is bounded (≤1 list per configured datanet per boot) and a
  // negative-result marker would wrongly freeze rows that become resolvable later
  // (transient CLI failure, datanet re-enabled).
  const unresolvedPods = new Set(rows.filter((r) => !podDatanet.has(r.podId)).map((r) => r.podId))
  if (unresolvedPods.size > 0) {
    for (const id of configuredDatanets) {
      if (id === '*') continue
      try {
        for (const podId of await listDatanetPodIds(id)) {
          if (!podDatanet.has(podId)) podDatanet.set(podId, id)
          unresolvedPods.delete(podId)
        }
      } catch { /* best-effort: a failed list skips that datanet's membership map */ }
      if (unresolvedPods.size === 0) break
    }
  }
  const update = db.prepare('UPDATE activity SET datanetId = ? WHERE id = ?')
  let ok = 0
  for (const row of rows) {
    const datanetId = podDatanet.get(row.podId)
    if (!datanetId) continue
    update.run(datanetId, row.id)
    ok++
  }
  console.error(`orquestra: claim-datanet backfill — ${ok}/${rows.length} historical claim(s) attributed`)
}

/** Back-fill reppoSpent for historical mint rows that predate the column (upgrading operators).
 *  Runs once at startup, fire-and-forget. Requires rpcUrl; logs a one-time warning without it.
 *  Safe to re-run: skips rows already having reppoSpent or missing txHash. */
export async function backfillMintReppoSpent(dataDir: string, rpcUrl: string | undefined): Promise<void> {
  const db = conn(dataDir)
  const rows = db.prepare(
    "SELECT id, txHash FROM activity WHERE kind='mint' AND status='executed' AND reppoSpent IS NULL AND txHash IS NOT NULL"
  ).all() as { id: number; txHash: string }[]
  if (rows.length === 0) return
  if (!rpcUrl) {
    console.warn(
      `orquestra: ${rows.length} historical mint(s) have no recorded REPPO spend — ` +
      `set RPC_URL to auto-backfill and get accurate lifetime PnL.`
    )
    return
  }
  console.error(`orquestra: backfilling reppoSpent for ${rows.length} historical mint(s) …`)
  const update = db.prepare('UPDATE activity SET reppoSpent = ? WHERE id = ?')
  let ok = 0
  for (const row of rows) {
    const fee = await readMintReppoFee(rpcUrl, row.txHash).catch(() => undefined)
    if (fee === undefined) continue
    update.run(fee, row.id)
    ok++
    await new Promise((r) => setTimeout(r, 80))
  }
  console.error(`orquestra: reppoSpent backfill complete — ${ok}/${rows.length} mints reconciled`)
}
