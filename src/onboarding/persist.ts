// src/onboarding/persist.ts
import { readFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, type SqliteDb } from '../dashboard/db.js'
import { hasConfig, writeConfig } from '../config/load.js'
import type { StrategyConfig } from '../config/schema.js'

const LEGACY_NOTES = 'strategy-notes.md'

/** True when no config exists yet (first run → run the interview). */
export function needsOnboarding(dataDir: string): boolean {
  return !hasConfig(dataDir)
}

/** Persist the validated config + the freeform notes to the data dir (SQLite). */
export function persistOnboarding(dataDir: string, config: StrategyConfig, notes: string): void {
  writeConfig(dataDir, config)
  writeNotes(dataDir, notes)
}

/** Operator strategy notes, stored as a single `notes` row (markdown body). */
export function writeNotes(dataDir: string, notes: string): void {
  const d = getDb(dataDir)
  ensureNotesMigrated(d, dataDir)
  d.prepare('INSERT INTO notes (id, text, updatedTs) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text, updatedTs = excluded.updatedTs')
    .run(`# Orquestra strategy notes\n\n${notes}\n`, new Date().toISOString())
}

/** Read the persisted notes markdown; null if unset. */
export function readNotes(dataDir: string): string | null {
  const d = getDb(dataDir)
  ensureNotesMigrated(d, dataDir)
  const row = d.prepare('SELECT text FROM notes WHERE id = 1').get() as { text: string } | undefined
  return row ? row.text : null
}

const notesImported = new Set<string>()
/** One-time import of a pre-existing strategy-notes.md into the empty `notes` row,
 *  then rename it *.imported. No-op once migrated. */
function ensureNotesMigrated(d: SqliteDb, dataDir: string): void {
  if (notesImported.has(dataDir)) return
  const n = (d.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number }).n
  if (n === 0) {
    const path = join(dataDir, LEGACY_NOTES)
    if (existsSync(path)) {
      d.prepare('INSERT INTO notes (id, text, updatedTs) VALUES (1, ?, ?)').run(readFileSync(path, 'utf-8'), new Date().toISOString())
      renameSync(path, path + '.imported')
    }
  }
  // Mark migrated only after a clean pass — a throw above leaves it retryable next call.
  notesImported.add(dataDir)
}
