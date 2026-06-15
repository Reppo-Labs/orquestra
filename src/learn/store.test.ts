import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetDbs } from '../dashboard/db.js'
import {
  upsertOutcome, readOutcomes, insertLesson, readLessons, clearLessons,
  insertProposal, readProposals, setProposalStatus, getLearnEnabled, setLearnEnabled,
  type OutcomeRow,
} from './store.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-learn-')) })
afterEach(() => { _resetDbs(); rmSync(dir, { recursive: true, force: true }) })

const outcome = (over: Partial<OutcomeRow> = {}): OutcomeRow => ({
  datanetId: '9', podId: 'p1', podName: 'Pod 1', kind: 'vote', direction: 'up',
  conviction: 8, judgeScore: 7, observedEpoch: 100,
  upVotes: 9, downVotes: 1, netVotes: 8, marginPct: 0.8, aligned: 1, matured: 1, frozen: 0,
  ...over,
})

describe('learn store — outcomes', () => {
  it('upserts on (datanetId, podId, kind): re-observing updates one row, never duplicates', () => {
    upsertOutcome(dir, outcome({ upVotes: 5, downVotes: 0, netVotes: 5 }))
    upsertOutcome(dir, outcome({ upVotes: 12, downVotes: 2, netVotes: 10 }))
    const rows = readOutcomes(dir, '9')
    expect(rows).toHaveLength(1)
    expect(rows[0].netVotes).toBe(10)        // updated, not a second row
  })

  it('a frozen outcome is never overwritten (deterministic learning input)', () => {
    upsertOutcome(dir, outcome({ frozen: 1, netVotes: 8, aligned: 1 }))
    upsertOutcome(dir, outcome({ frozen: 1, netVotes: -8, aligned: 0 })) // ignored
    const rows = readOutcomes(dir, '9')
    expect(rows).toHaveLength(1)
    expect(rows[0].netVotes).toBe(8)
    expect(rows[0].aligned).toBe(1)
  })

  it('vote and mint on the same pod are distinct rows (kind is part of the key)', () => {
    upsertOutcome(dir, outcome({ kind: 'vote' }))
    upsertOutcome(dir, outcome({ kind: 'mint', direction: undefined }))
    expect(readOutcomes(dir, '9')).toHaveLength(2)
  })

  it('readOutcomes filters by datanet and sinceEpoch', () => {
    upsertOutcome(dir, outcome({ podId: 'a', observedEpoch: 90 }))
    upsertOutcome(dir, outcome({ podId: 'b', observedEpoch: 110 }))
    upsertOutcome(dir, outcome({ datanetId: '2', podId: 'c', observedEpoch: 110 }))
    expect(readOutcomes(dir, '9')).toHaveLength(2)
    expect(readOutcomes(dir, '9', { sinceEpoch: 100 }).map((r) => r.podId)).toEqual(['b'])
  })
})

describe('learn store — lessons', () => {
  const lesson = () => ({ datanetId: '9', text: 'unsourced pods misaligned 7/9', source: 'calibration' as const, createdEpoch: 100, createdTs: '2026-06-15T00:00:00.000Z', active: 1 as const })

  it('inserts and reads active lessons; clearLessons (veto) deactivates them', () => {
    insertLesson(dir, lesson())
    insertLesson(dir, lesson())
    expect(readLessons(dir, '9', { activeOnly: true })).toHaveLength(2)
    clearLessons(dir, '9')
    expect(readLessons(dir, '9', { activeOnly: true })).toHaveLength(0)
    expect(readLessons(dir, '9')).toHaveLength(2) // kept for the audit trail
  })
})

describe('learn store — proposals', () => {
  const proposal = () => ({ datanetId: '9', field: 'strictness' as const, fromValue: 'balanced', toValue: 'conservative', rationale: 'high-conviction up-votes misaligned 8/10', basisConfigMtime: '2026-06-15T00:00:00.000Z', createdEpoch: 100, createdTs: '2026-06-15T00:00:00.000Z' })

  it('inserts pending, lists by status, and transitions on decision (returning the row)', () => {
    const id = insertProposal(dir, proposal())
    expect(readProposals(dir, { status: 'pending' })).toHaveLength(1)
    const updated = setProposalStatus(dir, id, 'accepted')
    expect(updated?.status).toBe('accepted')
    expect(updated?.toValue).toBe('conservative')
    expect(updated?.decidedTs).toBeTruthy()
    expect(readProposals(dir, { status: 'pending' })).toHaveLength(0)
  })

  it('setProposalStatus on an unknown id returns null', () => {
    expect(setProposalStatus(dir, 999, 'rejected')).toBeNull()
  })
})

describe('learn store — per-datanet flag', () => {
  it('defaults to on, and setLearnEnabled toggles it', () => {
    expect(getLearnEnabled(dir, '9')).toBe(true)   // no row → on
    setLearnEnabled(dir, '9', false)
    expect(getLearnEnabled(dir, '9')).toBe(false)
    setLearnEnabled(dir, '9', true)
    expect(getLearnEnabled(dir, '9')).toBe(true)
  })
})
