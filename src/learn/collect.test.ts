import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetDbs } from '../dashboard/db.js'
import { appendActivity, type ActivityEntry } from '../dashboard/activityLog.js'
import type { OwnPodVote } from '../dashboard/earnStatus.js'
import { buildOutcomes, collectOutcomes } from './collect.js'
import { readOutcomes } from './store.js'

const vote = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  ts: 't', cycleId: 'c', kind: 'vote', datanetId: '9', podId: 'p1', direction: 'up', conviction: 8, status: 'executed', ...over,
})
const pod = (over: Partial<OwnPodVote> = {}): OwnPodVote => ({ podId: 'p1', name: 'P1', validityEpoch: '100', upVotes: 9, downVotes: 1, ...over })

describe('buildOutcomes (pure)', () => {
  it('an up-vote on a net-positive matured pod is aligned + frozen', () => {
    const [o] = buildOutcomes('9', [vote()], [pod()], 101)
    expect(o).toMatchObject({ kind: 'vote', aligned: 1, matured: 1, frozen: 1, netVotes: 8 })
  })

  it('an up-vote on a net-negative pod is misaligned; a down-vote there is aligned', () => {
    const neg = [pod({ upVotes: 1, downVotes: 9 })]
    expect(buildOutcomes('9', [vote({ direction: 'up' })], neg, 101)[0].aligned).toBe(0)
    expect(buildOutcomes('9', [vote({ direction: 'down' })], neg, 101)[0].aligned).toBe(1)
  })

  it('maturity gate: still within validity epoch → not matured', () => {
    expect(buildOutcomes('9', [vote()], [pod({ validityEpoch: '100' })], 100)[0].matured).toBe(0)
  })

  it('maturity gate: below the min-vote floor (self-fulfilling guard) → not matured', () => {
    expect(buildOutcomes('9', [vote()], [pod({ upVotes: 3, downVotes: 0 })], 101)[0].matured).toBe(0)
  })

  it('maturity gate: a near-tie (margin < 0.2) → not matured', () => {
    expect(buildOutcomes('9', [vote()], [pod({ upVotes: 5, downVotes: 5 })], 101)[0].matured).toBe(0)
  })

  it('matches a mint by recorded name and scores it net-positive', () => {
    const mintAct = vote({ kind: 'mint', podId: undefined, podName: 'My Long Pod Name', conviction: 7 })
    const pods = [pod({ podId: 'm1', name: 'My Long Pod Name', upVotes: 7, downVotes: 1 })]
    const [o] = buildOutcomes('9', [mintAct], pods, 101)
    expect(o).toMatchObject({ kind: 'mint', podId: 'm1', aligned: 1, matured: 1 })
  })

  it('skips a voted pod that is not in the tally list', () => {
    expect(buildOutcomes('9', [vote({ podId: 'ghost' })], [pod()], 101)).toEqual([])
  })

  it('ignores non-executed activity', () => {
    expect(buildOutcomes('9', [vote({ status: 'refused-budget' })], [pod()], 101)).toEqual([])
  })
})

describe('collectOutcomes (IO, reuses the cycle pod tallies)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-collect-')) })
  afterEach(() => { _resetDbs(); rmSync(dir, { recursive: true, force: true }) })

  it('reads executed activity, persists matured outcomes', () => {
    appendActivity(dir, vote())
    const n = collectOutcomes(dir, '9', [pod()], 101)
    expect(n).toBe(1)
    const rows = readOutcomes(dir, '9')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ aligned: 1, matured: 1, frozen: 1 })
  })
})
