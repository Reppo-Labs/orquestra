import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, _resetDbs } from './db.js'

describe('db (shared SQLite owner)', () => {
  let dir: string
  afterEach(() => {
    _resetDbs()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('returns the same cached handle for a dataDir', () => {
    dir = mkdtempSync(join(tmpdir(), 'orq-db-'))
    expect(getDb(dir)).toBe(getDb(dir))
  })

  it('creates every table on first open (DDL idempotent across opens)', () => {
    dir = mkdtempSync(join(tmpdir(), 'orq-db-'))
    getDb(dir)
    _resetDbs()                      // force a re-open; DDL must not error on existing tables
    const d = getDb(dir)
    const names = (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name)
    for (const t of [
      'activity', 'earn_status', 'snapshot', 'budget_ledger', 'dedup',
      'config', 'agent', 'outcomes', 'lessons', 'proposals', 'learn_flags',
      'emit_pods', 'emit_scan', 'voter_scan',
    ]) {
      expect(names).toContain(t)
    }
  })
})
