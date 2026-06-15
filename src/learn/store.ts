// src/learn/store.ts
// Persistence for the self-learning loop. Four tables, all owned by db.ts and living
// in the shared activity.db: `outcomes` (matured vote/mint decisions matched to their
// on-chain tally), `lessons` (distilled, operator-vetoable guidance per datanet),
// `proposals` (operator-approved config tweaks), `learn_flags` (per-datanet on/off).
import { getDb } from '../dashboard/db.js'

export type OutcomeKind = 'vote' | 'mint'

/** A matured decision matched to the pod's on-chain tally. Keyed UNIQUE(datanetId,
 *  podId, kind): re-observing the same pod is an idempotent UPSERT, and once `frozen`
 *  the row is never overwritten (deterministic learning input across restarts). */
export interface OutcomeRow {
  datanetId: string
  podId: string
  podName?: string
  kind: OutcomeKind
  direction?: 'up' | 'down'  // votes only
  conviction?: number        // our score at decision time
  judgeScore?: number        // panel judge's final score, when a panel ran
  observedEpoch: number
  upVotes: number
  downVotes: number
  netVotes: number
  marginPct: number          // |up-down| / (up+down), 0..1
  aligned: 0 | 1
  matured: 0 | 1
  frozen: 0 | 1
}

export type LessonSource = 'calibration' | 'consensus-flag'
export interface LessonRow {
  id: number
  datanetId: string
  text: string
  source: LessonSource
  createdEpoch: number
  createdTs: string
  active: 0 | 1
}

export type ProposalField = 'strictness'
export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'stale'
export interface ProposalRow {
  id: number
  datanetId: string
  field: ProposalField
  fromValue: string
  toValue: string
  rationale: string
  basisConfigMtime: string
  createdEpoch: number
  createdTs: string
  status: ProposalStatus
  decidedTs: string | null
}

// ── outcomes ──────────────────────────────────────────────────────────────────
/** Insert or refresh an outcome. A row already marked `frozen` is left untouched
 *  (the WHERE on the conflict clause), so a matured tally never drifts afterward. */
export function upsertOutcome(dataDir: string, r: OutcomeRow): void {
  getDb(dataDir).prepare(
    `INSERT INTO outcomes
       (datanetId, podId, podName, kind, direction, conviction, judgeScore, observedEpoch,
        upVotes, downVotes, netVotes, marginPct, aligned, matured, frozen, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(datanetId, podId, kind) DO UPDATE SET
       podName = excluded.podName, direction = excluded.direction, conviction = excluded.conviction,
       judgeScore = excluded.judgeScore, observedEpoch = excluded.observedEpoch,
       upVotes = excluded.upVotes, downVotes = excluded.downVotes, netVotes = excluded.netVotes,
       marginPct = excluded.marginPct, aligned = excluded.aligned, matured = excluded.matured,
       frozen = excluded.frozen, ts = excluded.ts
     WHERE outcomes.frozen = 0`,
  ).run(
    r.datanetId, r.podId, r.podName ?? null, r.kind, r.direction ?? null, r.conviction ?? null,
    r.judgeScore ?? null, r.observedEpoch, r.upVotes, r.downVotes, r.netVotes, r.marginPct,
    r.aligned, r.matured, r.frozen, new Date().toISOString(),
  )
}

type OutcomeDbRow = Omit<OutcomeRow, 'direction'> & { direction: string | null }

export function readOutcomes(dataDir: string, datanetId: string, opts: { sinceEpoch?: number } = {}): OutcomeRow[] {
  const sql = opts.sinceEpoch !== undefined
    ? 'SELECT * FROM outcomes WHERE datanetId = ? AND observedEpoch >= ? ORDER BY id'
    : 'SELECT * FROM outcomes WHERE datanetId = ? ORDER BY id'
  const params = opts.sinceEpoch !== undefined ? [datanetId, opts.sinceEpoch] : [datanetId]
  const rows = getDb(dataDir).prepare(sql).all(...params) as OutcomeDbRow[]
  return rows.map((r) => ({ ...r, direction: (r.direction ?? undefined) as OutcomeRow['direction'] }))
}

// ── lessons ───────────────────────────────────────────────────────────────────
export function insertLesson(dataDir: string, l: Omit<LessonRow, 'id'>): number {
  const info = getDb(dataDir).prepare(
    'INSERT INTO lessons (datanetId, text, source, createdEpoch, createdTs, active) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(l.datanetId, l.text, l.source, l.createdEpoch, l.createdTs, l.active)
  return Number(info.lastInsertRowid)
}

export function readLessons(dataDir: string, datanetId: string, opts: { activeOnly?: boolean } = {}): LessonRow[] {
  const sql = opts.activeOnly
    ? 'SELECT * FROM lessons WHERE datanetId = ? AND active = 1 ORDER BY id'
    : 'SELECT * FROM lessons WHERE datanetId = ? ORDER BY id'
  return getDb(dataDir).prepare(sql).all(datanetId) as unknown as LessonRow[]
}

/** Operator veto: deactivate all of a datanet's lessons (kept for the audit trail). */
export function clearLessons(dataDir: string, datanetId: string): void {
  getDb(dataDir).prepare('UPDATE lessons SET active = 0 WHERE datanetId = ?').run(datanetId)
}

// ── proposals ─────────────────────────────────────────────────────────────────
export function insertProposal(dataDir: string, p: Omit<ProposalRow, 'id' | 'status' | 'decidedTs'>): number {
  const info = getDb(dataDir).prepare(
    `INSERT INTO proposals (datanetId, field, fromValue, toValue, rationale, basisConfigMtime, createdEpoch, createdTs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(p.datanetId, p.field, p.fromValue, p.toValue, p.rationale, p.basisConfigMtime, p.createdEpoch, p.createdTs)
  return Number(info.lastInsertRowid)
}

export function readProposals(dataDir: string, opts: { status?: ProposalStatus } = {}): ProposalRow[] {
  const sql = opts.status
    ? 'SELECT * FROM proposals WHERE status = ? ORDER BY id DESC'
    : 'SELECT * FROM proposals ORDER BY id DESC'
  const params = opts.status ? [opts.status] : []
  return getDb(dataDir).prepare(sql).all(...params) as unknown as ProposalRow[]
}

/** Transition a proposal and stamp decidedTs. Returns the updated row (so the caller
 *  can apply an accepted strictness change), or null if the id is unknown. */
export function setProposalStatus(dataDir: string, id: number, status: ProposalStatus): ProposalRow | null {
  const d = getDb(dataDir)
  d.prepare('UPDATE proposals SET status = ?, decidedTs = ? WHERE id = ?').run(status, new Date().toISOString(), id)
  return (d.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined) ?? null
}

// ── per-datanet learn flag (default ON) ─────────────────────────────────────────
export function getLearnEnabled(dataDir: string, datanetId: string): boolean {
  const row = getDb(dataDir).prepare('SELECT enabled FROM learn_flags WHERE datanetId = ?').get(datanetId) as
    | { enabled: number }
    | undefined
  return row ? row.enabled === 1 : true // no row → learning on by default
}

export function setLearnEnabled(dataDir: string, datanetId: string, enabled: boolean): void {
  getDb(dataDir).prepare(
    'INSERT INTO learn_flags (datanetId, enabled) VALUES (?, ?) ON CONFLICT(datanetId) DO UPDATE SET enabled = excluded.enabled',
  ).run(datanetId, enabled ? 1 : 0)
}
