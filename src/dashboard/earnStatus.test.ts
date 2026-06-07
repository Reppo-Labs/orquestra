// src/dashboard/earnStatus.test.ts
import { describe, it, expect } from 'vitest'
import { earnSummary, formatEarnStatus, type OwnPodVote } from './earnStatus.js'
import type { ActivityEntry } from './activityLog.js'
import type { EmissionsDue } from '../reppo/queryEmissionsDue.js'

const mint = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({ ts: 't', cycleId: 'c', kind: 'mint', datanetId: '9', canonicalKey: 'k', status: 'executed', ...over })
const claim = (reppo: number, status: ActivityEntry['status'] = 'executed'): ActivityEntry => ({ ts: 't', cycleId: 'c', kind: 'claim', datanetId: '9', podId: '1', epoch: 99, reppoClaimed: reppo, status })
const due = (totalReppo: number): EmissionsDue => ({ totalReppo, pods: [] })
const pod = (over: Partial<OwnPodVote> = {}): OwnPodVote => ({ podId: '1', name: 'HL perps', validityEpoch: '99', upVotes: 0, downVotes: 0, ...over })

describe('earnSummary', () => {
  it('counts executed mints, sums claimed, carries claimable + vote tallies', () => {
    const s = earnSummary(
      [mint(), mint({ status: 'error' }), mint({ cycleId: 'backfill' }), claim(12.5), claim(4, 'error')],
      due(3),
      [pod({ upVotes: 5, downVotes: 1 }), pod({ podId: '2', upVotes: 2, downVotes: 0 })],
    )
    expect(s.mintedPods).toBe(1)         // only executed, node-era (backfill rows excluded)
    expect(s.claimedReppo).toBe(12.5)    // only executed claim
    expect(s.claimableReppo).toBe(3)
    expect(s.totalUpVotes).toBe(7)
    expect(s.totalDownVotes).toBe(1)
    expect(s.earning).toBe(true)         // claimed > 0
  })

  it('earning is true when only claimable (not yet claimed)', () => {
    expect(earnSummary([mint()], due(5), []).earning).toBe(true)
  })

  it('earning is false when nothing claimed or claimable', () => {
    expect(earnSummary([mint()], due(0), [pod({ upVotes: 3 })]).earning).toBe(false)
  })
})

describe('formatEarnStatus', () => {
  it('renders an earning verdict', () => {
    const out = formatEarnStatus(earnSummary([mint()], due(5), [pod({ upVotes: 2 })]))
    expect(out).toMatch(/VERDICT: earning/)
    expect(out).toMatch(/claimable REPPO \(now\):  5/)
  })
  it('renders the "accruing upvotes" verdict when votes>0 but no emissions yet', () => {
    const out = formatEarnStatus(earnSummary([mint()], due(0), [pod({ upVotes: 4 })]))
    expect(out).toMatch(/accruing upvotes/)
  })
  it('renders the "too early" verdict when nothing yet', () => {
    const out = formatEarnStatus(earnSummary([mint()], due(0), []))
    expect(out).toMatch(/too early/)
  })
})
