import { describe, it, expect } from 'vitest'
import { buildHealth, extractErrorCode } from './health.js'
import type { ActivityEntry } from './activityLog.js'

const LACKS_ACCESS = 'Command failed: reppo vote --pod 922 --like --votes 8 — {"error":{"code":"VOTER_LACKS_SUBNET_ACCESS","message":"Vote tx failed to submit","hint":"Voter lacks subnet access."}}'
const BAD_NAME = 'Command failed: reppo mint-pod --datanet 2 — {"error":{"code":"INVALID_POD_NAME","message":"--pod-name must be ≤50 chars; got 144."}}'

const e = (over: Partial<ActivityEntry>): ActivityEntry => ({
  ts: '2026-06-09T00:00:00.000Z', cycleId: 'c1', kind: 'vote', datanetId: '2',
  status: 'executed', ...over,
})

describe('extractErrorCode', () => {
  it('pulls the CLI error code out of a command-failure detail', () => {
    expect(extractErrorCode(LACKS_ACCESS)).toBe('VOTER_LACKS_SUBNET_ACCESS')
    expect(extractErrorCode(BAD_NAME)).toBe('INVALID_POD_NAME')
  })
  it('buckets unparseable/missing details as UNKNOWN', () => {
    expect(extractErrorCode('something exploded')).toBe('UNKNOWN')
    expect(extractErrorCode(undefined)).toBe('UNKNOWN')
  })
})

describe('buildHealth', () => {
  it('counts by datanet × kind × status and ranks error codes', () => {
    const report = buildHealth([
      e({ kind: 'vote', status: 'error', detail: LACKS_ACCESS }),
      e({ kind: 'vote', status: 'error', detail: LACKS_ACCESS }),
      e({ kind: 'mint', status: 'error', detail: BAD_NAME }),
      e({ kind: 'vote', status: 'executed', datanetId: '9', txHash: '0x1' }),
      e({ kind: 'vote', status: 'refused-budget', datanetId: '9' }),
    ])
    const d2 = report.datanets.find((d) => d.datanetId === '2')!
    expect(d2.votes).toEqual({ executed: 0, refused: 0, error: 2 })
    expect(d2.mints).toEqual({ executed: 0, refused: 0, error: 1 })
    expect(d2.topErrors[0]).toEqual({ code: 'VOTER_LACKS_SUBNET_ACCESS', count: 2 })
    expect(d2.topErrors[1]).toEqual({ code: 'INVALID_POD_NAME', count: 1 })
    const d9 = report.datanets.find((d) => d.datanetId === '9')!
    expect(d9.votes).toEqual({ executed: 1, refused: 1, error: 0 })
  })

  it('surfaces the most recent skip reason (entries arrive newest-first)', () => {
    const report = buildHealth([
      e({ kind: 'skip', status: 'skipped', reason: 'newest reason' }),
      e({ kind: 'skip', status: 'skipped', reason: 'older reason' }),
    ])
    const d2 = report.datanets.find((d) => d.datanetId === '2')!
    expect(d2.skips).toBe(2)
    expect(d2.lastSkipReason).toBe('newest reason')
    expect(d2.idle).toBe(true) // newest entry is a skip → currently idle
  })

  it('idle is false once activity resumes after a skip (stale reasons must not show as idle)', () => {
    const report = buildHealth([
      e({ kind: 'vote', status: 'executed', txHash: '0x1' }),            // newest: a real vote
      e({ kind: 'skip', status: 'skipped', reason: 'old skip reason' }), // older skip
    ])
    const d2 = report.datanets.find((d) => d.datanetId === '2')!
    expect(d2.idle).toBe(false)
    expect(d2.lastSkipReason).toBe('old skip reason') // history retained, just not "idle"
  })

  it('handles an empty log', () => {
    expect(buildHealth([])).toEqual({ entriesScanned: 0, datanets: [] })
  })
})
