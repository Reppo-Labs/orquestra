import { describe, it, expect } from 'vitest'
import { computeStats } from './stats.js'
import type { OutcomeRow } from './store.js'

const o = (over: Partial<OutcomeRow>): OutcomeRow => ({
  datanetId: '9', podId: 'p', kind: 'vote', direction: 'up', conviction: 8, observedEpoch: 100,
  upVotes: 9, downVotes: 1, netVotes: 8, marginPct: 0.8, aligned: 1, matured: 1, frozen: 1, ...over,
})

describe('computeStats', () => {
  it('counts only matured outcomes', () => {
    const s = computeStats([o({ podId: 'a' }), o({ podId: 'b', matured: 0 })], '9')
    expect(s.maturedTotal).toBe(1)
    expect(s.voteTotal).toBe(1)
  })

  it('computes vote alignment and per-direction breakdown', () => {
    const s = computeStats([
      o({ podId: 'a', direction: 'up', aligned: 1 }),
      o({ podId: 'b', direction: 'up', aligned: 0 }),
      o({ podId: 'c', direction: 'down', aligned: 1 }),
    ], '9')
    expect(s.voteAlignmentPct).toBe(67)        // 2/3
    expect(s.upVoteTotal).toBe(2)
    expect(s.upVoteAlignedPct).toBe(50)        // 1/2
    expect(s.downVoteAlignedPct).toBe(100)     // 1/1
  })

  it('separates mint alignment from vote alignment', () => {
    const s = computeStats([
      o({ podId: 'a', kind: 'vote', aligned: 1 }),
      o({ podId: 'b', kind: 'mint', direction: undefined, aligned: 0 }),
    ], '9')
    expect(s.voteTotal).toBe(1)
    expect(s.mintTotal).toBe(1)
    expect(s.mintAlignmentPct).toBe(0)
  })

  it('buckets conviction calibration and flags high-conviction reversals', () => {
    const s = computeStats([
      o({ podId: 'a', conviction: 9, aligned: 1 }),
      o({ podId: 'b', conviction: 8, aligned: 0 }),   // high-conviction reversal
      o({ podId: 'c', conviction: 2, aligned: 1 }),
    ], '9')
    expect(s.highConvictionTotal).toBe(2)
    expect(s.highConvictionAlignedPct).toBe(50)
    expect(s.lowConvictionTotal).toBe(1)
    expect(s.highConvictionReversals).toBe(1)
  })

  it('returns zeroes (no divide-by-zero) on an empty matured set', () => {
    const s = computeStats([], '9')
    expect(s).toMatchObject({ maturedTotal: 0, voteAlignmentPct: 0, mintAlignmentPct: 0, sampleEpochs: 0 })
  })
})
