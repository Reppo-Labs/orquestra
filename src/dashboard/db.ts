// src/dashboard/db.ts
// Single owner of the node's SQLite database. ALL persistent state lives here in
// one file (activity.db — the name is legacy; it is now the unified store): activity
// history, stats (earn_status, snapshot), operational state (budget_ledger, dedup),
// config/identity (config, agent), and the self-learning tables (outcomes,
// lessons, proposals, learn_flags). No runtime state is read from or written to
// JSON/MD files; each former file is imported once by its store module then renamed
// `.imported`.
//
// `getDb(dataDir)` returns a cached handle and runs every `CREATE TABLE IF NOT EXISTS`
// on first open. Each store module (activityLog, earnStatus, snapshot, ledger, state,
// config, agent, learn/*) shares this one handle and owns its own one-time migration.
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

// Load node:sqlite via createRequire so the test bundler (Vite/vitest) doesn't try to
// statically resolve it — it's newer than Vite's builtin externals list. At runtime
// this is Node's own require, resolving the built-in module directly.
export type SqliteDb = import('node:sqlite').DatabaseSync
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

const DB_FILE = 'activity.db'
const dbs = new Map<string, SqliteDb>()

// All DDL is idempotent (`IF NOT EXISTS`); creating tables a phase doesn't use yet is
// harmless. Single-row tables use `CHECK (id = 1)` so there is exactly one config /
// ledger / notes / agent row.
const DDL = `
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, cycleId TEXT, kind TEXT, datanetId TEXT, podId TEXT,
  direction TEXT, conviction REAL, reason TEXT, canonicalKey TEXT, podName TEXT,
  epoch INTEGER, reppoClaimed REAL, status TEXT, txHash TEXT, gasEth REAL,
  detail TEXT, panel TEXT,
  claimedTokenSymbol TEXT, claimedTokenAmount REAL
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts);

CREATE TABLE IF NOT EXISTS earn_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, cycleId TEXT, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, cycleId TEXT, data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_ledger (
  id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dedup (
  kind TEXT NOT NULL, datanetId TEXT NOT NULL, key TEXT NOT NULL,
  PRIMARY KEY (kind, datanetId, key)
);

CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updatedTs TEXT
);
CREATE TABLE IF NOT EXISTS agent (
  id INTEGER PRIMARY KEY CHECK (id = 1), agentId TEXT, apiKey TEXT, name TEXT
);

CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  datanetId TEXT NOT NULL, podId TEXT NOT NULL, podName TEXT,
  kind TEXT NOT NULL, direction TEXT, conviction REAL, judgeScore REAL,
  observedEpoch INTEGER NOT NULL,
  upVotes INTEGER, downVotes INTEGER, netVotes INTEGER, marginPct REAL,
  aligned INTEGER, matured INTEGER, frozen INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL,
  UNIQUE(datanetId, podId, kind)
);
CREATE INDEX IF NOT EXISTS idx_outcomes_dn ON outcomes(datanetId);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  datanetId TEXT NOT NULL, text TEXT NOT NULL, source TEXT,
  createdEpoch INTEGER, createdTs TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_lessons_dn ON lessons(datanetId, active);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  datanetId TEXT NOT NULL, field TEXT NOT NULL,
  fromValue TEXT, toValue TEXT, rationale TEXT,
  basisConfigMtime TEXT, createdEpoch INTEGER, createdTs TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', decidedTs TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, datanetId);

CREATE TABLE IF NOT EXISTS learn_flags (
  datanetId TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1
);

-- On-chain emissions: cache of pod NFTs our wallet owns (enumerated from Transfer
-- logs) + the last block scanned, so each cycle only reads new logs incrementally.
CREATE TABLE IF NOT EXISTS emit_pods (
  podId TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS emit_scan (
  id INTEGER PRIMARY KEY CHECK (id = 1), lastBlock TEXT NOT NULL
);
-- Per-pod watermark for the VOTER-emissions scan: the highest CLOSED epoch already scanned
-- for this pod, so steady-state only checks new epochs (the first run deep-scans full history).
CREATE TABLE IF NOT EXISTS voter_scan (
  podId TEXT PRIMARY KEY, throughEpoch INTEGER NOT NULL
);
-- Same watermark for the OWNER-emissions scan (pods our wallet owns). Separate table:
-- the two scans cover different (pod,epoch) grids and advance independently.
CREATE TABLE IF NOT EXISTS owner_scan (
  podId TEXT PRIMARY KEY, throughEpoch INTEGER NOT NULL
);

-- econ_epochs = per-(datanet, epoch) REPPO economics buckets for the learn loop's
-- economics half (additive upserts from src/learn/econ.ts). econ_watermark = last
-- processed activity.id, so every activity row is counted exactly once.
CREATE TABLE IF NOT EXISTS econ_epochs (
  datanetId TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  ownerClaimedReppo REAL NOT NULL DEFAULT 0,
  voterClaimedReppo REAL NOT NULL DEFAULT 0,
  mintCostReppo REAL NOT NULL DEFAULT 0,
  mintCount INTEGER NOT NULL DEFAULT 0,
  votesCast INTEGER NOT NULL DEFAULT 0,
  updatedTs TEXT NOT NULL,
  PRIMARY KEY (datanetId, epoch)
);
CREATE TABLE IF NOT EXISTS econ_watermark (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lastActivityId INTEGER NOT NULL
);
`

/** Cached SQLite handle for this dataDir, with all tables ensured on first open. */
export function getDb(dataDir: string): SqliteDb {
  // resolve() so differently-spelled paths for the same dir (relative vs absolute,
  // trailing slash) share ONE handle — the single-connection invariant the migrations
  // and transactions rely on.
  const path = resolve(join(dataDir, DB_FILE))
  const existing = dbs.get(path)
  if (existing) return existing
  const d = new DatabaseSync(path)
  d.exec(DDL)
  migrate(d)
  dbs.set(path, d)
  return d
}

/** Idempotent column additions for DBs created before a column existed (CREATE TABLE IF NOT
 *  EXISTS won't add columns to an existing table). Each entry is added only when absent, so
 *  this is a safe no-op on fresh DBs (the column is already in DDL) and on already-migrated ones.
 *  Column names/types are hardcoded literals below — no external input reaches the SQL. */
function migrate(d: SqliteDb): void {
  // node:sqlite DatabaseSync.exec (DDL), not child_process — table/column names are literals.
  const addColumns = (table: string, add: [string, string][]): void => {
    const cols = (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    for (const [name, type] of add) {
      if (cols.includes(name)) continue
      d.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
    }
  }
  addColumns('activity', [
    ['claimedTokenSymbol', 'TEXT'],
    ['claimedTokenAmount', 'REAL'],
    ['reppoSpent', 'REAL'],
  ])
  // agent.name: the display name last synced to the Reppo platform, so a changed
  // REPPO_AGENT_NAME is detectable (and PATCHable) on restart. NULL on pre-migration
  // rows → treated as "unknown", synced once on the next start.
  addColumns('agent', [['name', 'TEXT']])
}

/** Test helper: close and forget all cached handles. */
export function _resetDbs(): void {
  for (const d of dbs.values()) {
    try { d.close() } catch { /* already closed */ }
  }
  dbs.clear()
}
