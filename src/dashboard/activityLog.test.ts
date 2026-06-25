import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendActivity, readActivity, readActivitySince, sumClaimedReppo, type ActivityEntry } from './activityLog.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-act-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  ts: '2026-06-03T21:38:38.651Z', cycleId: 'c1', kind: 'vote', datanetId: '9',
  podId: '1', direction: 'up', conviction: 9, reason: 'r', status: 'executed', txHash: '0xabc', ...over,
})

describe('activityLog (sqlite)', () => {
  it('append then read returns entries newest-first', () => {
    appendActivity(dir, entry({ podId: '1' }))
    appendActivity(dir, entry({ podId: '2' }))
    expect(readActivity(dir, { limit: 10 }).map((r) => r.podId)).toEqual(['2', '1'])
  })

  it('returns [] when nothing has been logged', () => {
    expect(readActivity(dir, { limit: 10 })).toEqual([])
  })

  it('honours the limit (most recent N)', () => {
    for (let i = 0; i < 5; i++) appendActivity(dir, entry({ podId: String(i) }))
    expect(readActivity(dir, { limit: 2 }).map((r) => r.podId)).toEqual(['4', '3'])
  })

  it('drops absent optional fields (shape matches the JSONL contract)', () => {
    appendActivity(dir, { ts: 't', cycleId: 'c', kind: 'skip', datanetId: '2', reason: 'x', status: 'skipped' })
    const [row] = readActivity(dir, { limit: 1 })
    expect(row).not.toHaveProperty('podId')
    expect(row).not.toHaveProperty('conviction')
    expect(row).toMatchObject({ kind: 'skip', datanetId: '2', status: 'skipped', reason: 'x' })
  })

  it('redacts rpc-url keys from detail at append time', () => {
    appendActivity(dir, entry({
      status: 'error',
      detail: 'Command failed: reppo vote --rpc-url https://base-mainnet.g.alchemy.com/v2/SECRET123 — {"error":{}}',
    }))
    const [row] = readActivity(dir, { limit: 1 })
    expect(row.detail).not.toContain('SECRET123')
    expect(row.detail).toContain('--rpc-url <redacted>')
  })

  it('redacts secrets inside the panel transcript', () => {
    appendActivity(dir, entry({
      panel: {
        screenScore: 8,
        panelists: [{ persona: 'bull', score: 9, argument: 'see --rpc-url https://base-mainnet.g.alchemy.com/v2/SECRET123' }],
        judge: { score: 7, reason: 'via --rpc-url https://base-mainnet.g.alchemy.com/v2/SECRET123' },
      },
    }))
    const [row] = readActivity(dir, { limit: 1 })
    expect(JSON.stringify(row.panel)).not.toContain('SECRET123')
    expect(row.panel!.panelists[0].argument).toContain('<redacted>')
    expect(row.panel!.judge.reason).toContain('<redacted>')
    expect(row.panel!.screenScore).toBe(8) // non-string fields survive intact
  })

  it('readActivitySince returns only entries at/after the cutoff, newest-first', () => {
    appendActivity(dir, entry({ podId: 'old', ts: '2026-06-01T00:00:00.000Z' }))
    appendActivity(dir, entry({ podId: 'new', ts: '2026-06-10T00:00:00.000Z' }))
    const since = Date.parse('2026-06-05T00:00:00.000Z')
    expect(readActivitySince(dir, since).map((r) => r.podId)).toEqual(['new'])
  })

  it('round-trips a claim entry with numeric fields', () => {
    appendActivity(dir, { ts: 't', cycleId: 'c', kind: 'claim', datanetId: '9', epoch: 104, reppoClaimed: 12.5, status: 'executed', txHash: '0xc' })
    const [row] = readActivity(dir, { limit: 1 })
    expect(row).toMatchObject({ kind: 'claim', epoch: 104, reppoClaimed: 12.5 })
  })

  it('sumClaimedReppo sums ALL executed claims, unbounded by any read window', () => {
    // More claims than any dashboard read limit would surface — the sum must not
    // depend on a recent-rows window (the PnL truncation bug).
    appendActivity(dir, { ts: 't', cycleId: 'c', kind: 'claim', datanetId: '9', reppoClaimed: 1800, status: 'executed' })
    for (let i = 0; i < 50; i++) {
      appendActivity(dir, entry({ podId: String(i) })) // 50 non-claim vote rows pushing the big claim "old"
    }
    appendActivity(dir, { ts: 't', cycleId: 'c', kind: 'claim', datanetId: '9', reppoClaimed: 10, status: 'executed' })
    appendActivity(dir, { ts: 't', cycleId: 'c', kind: 'claim', datanetId: '9', reppoClaimed: 5, status: 'error' }) // excluded
    expect(sumClaimedReppo(dir)).toBe(1810) // 1800 + 10, error claim ignored
  })

  it('sumClaimedReppo returns 0 when there are no claims', () => {
    appendActivity(dir, entry())
    expect(sumClaimedReppo(dir)).toBe(0)
  })

  it('imports a pre-existing activity-log.jsonl once, preserving history, then renames it', () => {
    const jsonl = join(dir, 'activity-log.jsonl')
    writeFileSync(jsonl,
      JSON.stringify({ ts: '2026-06-01T00:00:00.000Z', cycleId: 'c0', kind: 'vote', datanetId: '2', podId: 'legacy1', status: 'executed' }) + '\n' +
      JSON.stringify({ ts: '2026-06-02T00:00:00.000Z', cycleId: 'c0', kind: 'vote', datanetId: '2', podId: 'legacy2', status: 'executed' }) + '\n' +
      '{"torn line' + '\n')
    // first DB touch triggers the import
    const rows = readActivity(dir, { limit: 10 })
    expect(rows.map((r) => r.podId)).toEqual(['legacy2', 'legacy1']) // newest-first, torn line skipped
    expect(existsSync(jsonl)).toBe(false)
    expect(existsSync(jsonl + '.imported')).toBe(true)
    // new appends coexist with imported history; import does not re-run
    appendActivity(dir, entry({ podId: 'fresh', ts: '2026-06-03T00:00:00.000Z' }))
    expect(readActivity(dir, { limit: 10 }).map((r) => r.podId)).toEqual(['fresh', 'legacy2', 'legacy1'])
  })
})
