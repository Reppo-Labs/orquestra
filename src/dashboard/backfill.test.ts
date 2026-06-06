// src/dashboard/backfill.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBackfillEntries, backfillActivityLog } from './backfill.js'
import { readActivity } from './activityLog.js'
import type { VoterPod } from '../voter/types.js'

const pod = (podId: string, name = `pod ${podId}`, validityEpoch = '101'): VoterPod => ({ podId, name, validityEpoch, description: name })

describe('buildBackfillEntries', () => {
  it('makes one vote entry per voted pod and one mint entry per own pod', () => {
    const entries = buildBackfillEntries(
      { '9': ['1', '2'], '2': ['5'] },
      { '9': [pod('100', 'Alpha')] },
      't0',
    )
    const votes = entries.filter((e) => e.kind === 'vote')
    const mints = entries.filter((e) => e.kind === 'mint')
    expect(votes).toHaveLength(3)
    expect(mints).toHaveLength(1)
    expect(votes.every((e) => e.cycleId === 'backfill' && e.status === 'executed' && e.ts === 't0')).toBe(true)
    expect(mints[0]).toMatchObject({ kind: 'mint', datanetId: '9', canonicalKey: '100', podName: 'Alpha', epoch: 101 })
    // backfilled votes carry no direction/tx (old code never captured them)
    expect(votes[0].direction).toBeUndefined()
    expect(votes[0].txHash).toBeUndefined()
  })

  it('handles empty inputs', () => {
    expect(buildBackfillEntries({}, {}, 't')).toEqual([])
  })
})

describe('backfillActivityLog', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-bf-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads vote-state.json + own pods and appends rows, then is idempotent on re-run', async () => {
    writeFileSync(join(dir, 'vote-state.json'), JSON.stringify({ votedPodIds: { '9': ['1', '2'] }, mintedKeys: {}, claimedKeys: [] }))
    const listOwnPods = async (id: string) => (id === '9' ? [pod('100', 'Alpha')] : [])

    const first = await backfillActivityLog(dir, ['9', '2'], listOwnPods, 't0')
    expect(first).toEqual({ votes: 2, mints: 1, skipped: false })
    expect(readActivity(dir, { limit: 100 })).toHaveLength(3)

    // second run must NOT duplicate
    const second = await backfillActivityLog(dir, ['9', '2'], listOwnPods, 't1')
    expect(second.skipped).toBe(true)
    expect(readActivity(dir, { limit: 100 })).toHaveLength(3)
  })

  it('isolates a failing own-pods query — votes still backfill', async () => {
    writeFileSync(join(dir, 'vote-state.json'), JSON.stringify({ votedPodIds: { '9': ['1'] } }))
    const listOwnPods = async (id: string) => { if (id === '9') throw new Error('rpc down'); return [] as VoterPod[] }
    const r = await backfillActivityLog(dir, ['9'], listOwnPods, 't0')
    expect(r.votes).toBe(1)
    expect(r.mints).toBe(0) // datanet 9 own-pods query failed, skipped
  })
})
