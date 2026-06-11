import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
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

  it('rotates the live file at maxBytes but readActivity still spans the archive (history preserved)', () => {
    appendActivity(dir, entry({ podId: 'old1' }))
    appendActivity(dir, entry({ podId: 'old2' }), { maxBytes: 10 }) // file already > 10 bytes → rotates first
    // live file now holds only old2; old1 is in .old
    expect(existsSync(join(dir, 'activity-log.jsonl.old'))).toBe(true)
    expect(readFileSync(join(dir, 'activity-log.jsonl'), 'utf-8')).not.toContain('old1')
    // readActivity spans both, newest-first: live (old2) then archived (old1)
    expect(readActivity(dir, { limit: 10 }).map((r) => r.podId)).toEqual(['old2', 'old1'])
  })

  it('redacts rpc-url keys from detail/reason at append time', () => {
    appendActivity(dir, entry({
      status: 'error',
      detail: 'Command failed: reppo vote --pod 1 --rpc-url https://base-mainnet.g.alchemy.com/v2/SECRET123 — {"error":{"code":"X"}}',
    }))
    const [row] = readActivity(dir, { limit: 1 })
    expect(row.detail).not.toContain('SECRET123')
    expect(row.detail).toContain('--rpc-url <redacted>')
  })

  it('redacts secrets inside the panel transcript (panelist arguments + judge reason)', () => {
    appendActivity(dir, entry({
      panel: {
        screenScore: 8,
        panelists: [{ persona: 'bull', score: 9, argument: 'see --rpc-url https://base-mainnet.g.alchemy.com/v2/SECRET123' }],
        judge: { score: 7, reason: 'verified via --rpc-url https://base-mainnet.g.alchemy.com/v2/SECRET123' },
      },
    }))
    const [row] = readActivity(dir, { limit: 1 })
    expect(JSON.stringify(row.panel)).not.toContain('SECRET123')
    expect(row.panel!.panelists[0].argument).toContain('<redacted>')
    expect(row.panel!.judge.reason).toContain('<redacted>')
  })

  it('serves repeat reads from cache and picks up appends (cache invalidated by size/mtime)', () => {
    appendActivity(dir, entry({ podId: '1' }))
    expect(readActivity(dir, { limit: 10 })).toHaveLength(1)
    // cached read with a different limit still slices correctly
    appendActivity(dir, entry({ podId: '2' }))
    appendActivity(dir, entry({ podId: '3' }))
    expect(readActivity(dir, { limit: 2 }).map((r) => r.podId)).toEqual(['3', '2'])
    expect(readActivity(dir, { limit: 10 })).toHaveLength(3) // append seen, full list intact
  })

  it('round-trips a skip entry (kind skip, status skipped, reason)', () => {
    appendActivity(dir, {
      ts: '2026-06-09T00:00:00.000Z', cycleId: 'c1', kind: 'skip', datanetId: '2',
      reason: 'subnet access not granted (grant-access refused-budget: grant REPPO budget exhausted)',
      status: 'skipped',
    })
    const out = readActivity(dir, { limit: 10 })
    expect(out[0]).toMatchObject({ kind: 'skip', datanetId: '2', status: 'skipped' })
    expect(out[0].reason).toMatch(/subnet access not granted/)
  })
})
