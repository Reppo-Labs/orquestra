import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendActivity, readActivity, type ActivityEntry } from './activityLog.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-act-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  ts: '2026-06-03T21:38:38.651Z', cycleId: 'c1', kind: 'vote', datanetId: '9',
  podId: '1', direction: 'up', conviction: 9, reason: 'r', status: 'executed', txHash: '0xabc', ...over,
})

describe('activityLog', () => {
  it('append then read returns entries newest-first', () => {
    appendActivity(dir, entry({ podId: '1' }))
    appendActivity(dir, entry({ podId: '2' }))
    const rows = readActivity(dir, { limit: 10 })
    expect(rows.map((r) => r.podId)).toEqual(['2', '1']) // newest first
  })

  it('returns [] when the log does not exist', () => {
    expect(readActivity(dir, { limit: 10 })).toEqual([])
  })

  it('honours the limit (most recent N)', () => {
    for (let i = 0; i < 5; i++) appendActivity(dir, entry({ podId: String(i) }))
    const rows = readActivity(dir, { limit: 2 })
    expect(rows.map((r) => r.podId)).toEqual(['4', '3'])
  })

  it('tolerates a torn final line (partial write)', () => {
    appendActivity(dir, entry({ podId: '1' }))
    appendFileSync(join(dir, 'activity-log.jsonl'), '{"ts":"x","kind":"vote"') // no newline, invalid
    const rows = readActivity(dir, { limit: 10 })
    expect(rows.map((r) => r.podId)).toEqual(['1']) // bad line skipped
  })
})
