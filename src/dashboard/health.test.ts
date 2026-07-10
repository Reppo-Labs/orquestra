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
    expect(buildHealth([])).toEqual({ entriesScanned: 0, datanets: [], txRate: { executed: 0, failed: 0, rate: null } })
  })

  it('computes txRate per datanet and overall: executed/(executed+error), refused EXCLUDED', () => {
    const report = buildHealth([
      e({ kind: 'vote', status: 'executed', txHash: '0x1' }),
      e({ kind: 'vote', status: 'executed', txHash: '0x2' }),
      e({ kind: 'mint', status: 'error', detail: BAD_NAME }),
      e({ kind: 'vote', status: 'refused-budget' }),          // excluded from rate
      e({ kind: 'vote', status: 'executed', datanetId: '9', txHash: '0x3' }),
    ])
    const d2 = report.datanets.find((d) => d.datanetId === '2')!
    expect(d2.txRate).toEqual({ executed: 2, failed: 1, rate: 2 / 3 })
    const d9 = report.datanets.find((d) => d.datanetId === '9')!
    expect(d9.txRate).toEqual({ executed: 1, failed: 0, rate: 1 })
    expect(report.txRate).toEqual({ executed: 3, failed: 1, rate: 3 / 4 })
  })

  it('CANNOT_VOTE_FOR_OWN_POD is NOT a failed tx (pre-broadcast rejection) but stays in error counts', () => {
    const OWN = 'Command failed: reppo vote --pod 9 — {"error":{"code":"CANNOT_VOTE_FOR_OWN_POD","hint":"Publishers cannot vote on their own pods."}}'
    const report = buildHealth([
      e({ kind: 'vote', status: 'executed', txHash: '0x1' }),
      e({ kind: 'vote', status: 'error', detail: OWN }),
      e({ kind: 'vote', status: 'error', detail: LACKS_ACCESS }),
    ])
    const d2 = report.datanets.find((d) => d.datanetId === '2')!
    expect(d2.votes.error).toBe(2)                                   // still counted as errors
    expect(d2.topErrors.map((t) => t.code)).toContain('CANNOT_VOTE_FOR_OWN_POD') // still visible
    expect(d2.txRate).toEqual({ executed: 1, failed: 1, rate: 0.5 }) // but excluded from the rate
    expect(report.txRate).toEqual({ executed: 1, failed: 1, rate: 0.5 })
  })

  it('txRate.rate is null when there were no attempts (no executed, no error)', () => {
    const report = buildHealth([e({ kind: 'skip', status: 'skipped', reason: 'r' })])
    const d2 = report.datanets.find((d) => d.datanetId === '2')!
    expect(d2.txRate).toEqual({ executed: 0, failed: 0, rate: null })
    expect(report.txRate).toEqual({ executed: 0, failed: 0, rate: null })
  })

  it('info rows are invisible to health: not counted, and never mask idleness', () => {
    const report = buildHealth([
      // newest: this cycle's economics breadcrumb
      { ts: '2026-07-09T12:00:02Z', cycleId: 'c2', kind: 'info', datanetId: '9', reason: '500 REPPO/epoch · epoch 42 vote volume 0 — uncontested', status: 'executed' },
      // next-newest REAL entry is a skip → the datanet IS idle
      { ts: '2026-07-09T12:00:01Z', cycleId: 'c2', kind: 'skip', datanetId: '9', reason: 'no votable pods', status: 'skipped' },
      { ts: '2026-07-09T11:00:00Z', cycleId: 'c1', kind: 'vote', datanetId: '9', status: 'executed' },
    ] as ActivityEntry[])
    const n = report.datanets.find((d) => d.datanetId === '9')!
    expect(n.idle).toBe(true)                                       // info did NOT mask the skip
    expect(n.claims).toEqual({ executed: 0, refused: 0, error: 0 }) // info NOT bucketed as a claim
    expect(n.txRate.executed).toBe(1)                               // only the real vote counts
    expect(n.skips).toBe(1)
  })

  it('windowing: ignores entries older than sinceMs while keeping newer ones', () => {
    const now = Date.parse('2026-06-09T12:00:00.000Z')
    const report = buildHealth([
      e({ ts: '2026-06-09T11:00:00.000Z', kind: 'vote', status: 'executed', txHash: '0x1' }), // 1h old → in
      e({ ts: '2026-06-01T00:00:00.000Z', kind: 'vote', status: 'error', detail: LACKS_ACCESS }), // 8d old → out
    ], { sinceMs: now - 7 * 24 * 3600_000 })
    const d2 = report.datanets.find((d) => d.datanetId === '2')!
    expect(d2.votes).toEqual({ executed: 1, refused: 0, error: 0 })
    expect(report.entriesScanned).toBe(1)
  })
})
