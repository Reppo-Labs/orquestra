import { describe, it, expect } from 'vitest'
import { derivePnl } from './pnl.js'
import type { Snapshot } from './snapshot.js'

const snapshot: Snapshot = {
  ts: 't', cycleId: 'c1',
  balance: { eth: 0.4, reppo: 1850, veReppo: 500, usdc: 0 },
  votingPower: { power: 500, lockupCount: 1 },
  emissionsDue: { totalReppo: 5, pods: [{ podId: '9', datanetId: '9', epoch: 101, reppo: 5 }] },
  budget: { mintReppoSpent: 100, mintGasSpentEth: 0.003, voteGasSpentEth: 0.001, claimGasSpentEth: 0.0007,
    caps: { voteGasEthMax: 0.05, voteRateMaxPerCycle: 30, mintReppoMax: 500, mintGasEthMax: 0.05, claimGasEthMax: 0.05 } },
}

describe('derivePnl', () => {
  it('uses the passed claimed and mint-spent totals for net (both lifetime)', () => {
    const p = derivePnl(snapshot, 163, 100) // both args are lifetime activity-log sums
    expect(p.claimedReppo).toBe(163)
    expect(p.claimableReppo).toBe(5)      // snapshot.emissionsDue.totalReppo
    expect(p.earnedReppo).toBe(168)       // 163 + 5
    expect(p.spentReppo).toBe(100)        // lifetime mint spend, NOT snapshot.budget.mintReppoSpent
    expect(p.netReppo).toBe(68)           // 168 - 100
    expect(p.gasSpentEth).toBeCloseTo(0.0047) // 0.003 + 0.001 + 0.0007
  })

  it('handles zero claimed', () => {
    const p = derivePnl(snapshot, 0, 0)
    expect(p.claimedReppo).toBe(0)
    expect(p.earnedReppo).toBe(5)
  })

  it('net is accurate across a horizon reset (horizon-rollover fix)', () => {
    // Before fix: budget.mintReppoSpent reset to 30 at horizon rollover while
    // claimedReppo stayed lifetime → net read +6050 instead of true ~+1145.
    // Now both args are lifetime from the activity log; horizon rollover has no effect.
    const big: Snapshot = { ...snapshot, budget: { ...snapshot.budget, mintReppoSpent: 30 }, emissionsDue: { totalReppo: 0, pods: [] } }
    const p = derivePnl(big, 6080, 4935) // 6080 claimed, 4935 lifetime mint spend
    expect(p.netReppo).toBeCloseTo(1145)  // 6080 - 4935, not 6080 - 30
  })
})
