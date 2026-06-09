import { describe, it, expect } from 'vitest'
import { derivePnl } from './pnl.js'
import type { Snapshot } from './snapshot.js'
import type { ActivityEntry } from './activityLog.js'

const snapshot: Snapshot = {
  ts: 't', cycleId: 'c1',
  balance: { eth: 0.4, reppo: 1850, veReppo: 500, usdc: 0 },
  votingPower: { power: 500, lockupCount: 1 },
  emissionsDue: { totalReppo: 5, pods: [{ podId: '9', datanetId: '9', epoch: 101, reppo: 5 }] },
  budget: { mintReppoSpent: 100, mintGasSpentEth: 0.003, voteGasSpentEth: 0.001, claimGasSpentEth: 0.0007,
    caps: { voteGasEthMax: 0.05, voteRateMaxPerCycle: 30, mintReppoMax: 500, mintGasEthMax: 0.05, claimGasEthMax: 0.05, grantReppoMax: 0 } },
}
const a = (over: Partial<ActivityEntry>): ActivityEntry => ({ ts: 't', cycleId: 'c1', kind: 'claim', datanetId: '9', status: 'executed', ...over })

describe('derivePnl', () => {
  it('sums executed claims for claimedReppo and adds claimable for earned', () => {
    const activity = [a({ reppoClaimed: 100 }), a({ reppoClaimed: 63 }), a({ reppoClaimed: 50, status: 'error' })]
    const p = derivePnl(snapshot, activity)
    expect(p.claimedReppo).toBe(163)      // only executed claims
    expect(p.claimableReppo).toBe(5)      // snapshot.emissionsDue.totalReppo
    expect(p.earnedReppo).toBe(168)       // 163 + 5
    expect(p.spentReppo).toBe(100)        // mintReppoSpent
    expect(p.netReppo).toBe(68)           // 168 - 100
    expect(p.gasSpentEth).toBeCloseTo(0.0047) // 0.003 + 0.001 + 0.0007
  })

  it('handles empty activity', () => {
    const p = derivePnl(snapshot, [])
    expect(p.claimedReppo).toBe(0)
    expect(p.earnedReppo).toBe(5)
  })
})
