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

export interface ActivityEntry {
  ts: string
  cycleId: string
  // 'grant' = a one-time subnet access grant breadcrumb (records the fee paid, e.g.
  //  "granted access — paid 50 EXY"). Distinct from 'skip' so a successful grant is
  //  NOT counted as idleness/skip in buildHealth. The `kind` column is plain TEXT, so
  //  this needs no DDL change. (db.ts activity.kind has no CHECK constraint.)
  kind: 'vote' | 'mint' | 'claim' | 'skip' | 'grant'
  datanetId: string
  podId?: string
  direction?: 'up' | 'down'
  conviction?: number
  reason?: string
  canonicalKey?: string
  podName?: string
  epoch?: number
  reppoClaimed?: number
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

/** Entries at or after `sinceMs` (epoch millis), newest-first. Indexed on ts, so
 *  the dashboard health window doesn't re-read the whole history each poll. */
export function readActivitySince(dataDir: string, sinceMs: number): ActivityEntry[] {
  const since = new Date(sinceMs).toISOString()
  const rows = conn(dataDir).prepare('SELECT * FROM activity WHERE ts >= ? ORDER BY id DESC').all(since) as Row[]
  return rows.map(rowToEntry)
}
