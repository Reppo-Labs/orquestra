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
  it('uses the passed claimed total and adds claimable for earned', () => {
    const p = derivePnl(snapshot, 163) // caller passes the unbounded executed-claim sum
    expect(p.claimedReppo).toBe(163)
    expect(p.claimableReppo).toBe(5)      // snapshot.emissionsDue.totalReppo
    expect(p.earnedReppo).toBe(168)       // 163 + 5
    expect(p.spentReppo).toBe(100)        // mintReppoSpent
    expect(p.netReppo).toBe(68)           // 168 - 100
    expect(p.gasSpentEth).toBeCloseTo(0.0047) // 0.003 + 0.001 + 0.0007
  })

  it('handles zero claimed', () => {
    const p = derivePnl(snapshot, 0)
    expect(p.claimedReppo).toBe(0)
    expect(p.earnedReppo).toBe(5)
  })

  it('net stays positive when claimed exceeds spend (the truncation-bug scenario)', () => {
    // Real data: lifetime claimed 5309 vs mint spend 4935 → +374, not the
    // −2166 a windowed claim sum produced.
    const big: Snapshot = { ...snapshot, budget: { ...snapshot.budget, mintReppoSpent: 4935 }, emissionsDue: { totalReppo: 0, pods: [] } }
    const p = derivePnl(big, 5309)
    expect(p.netReppo).toBeCloseTo(374)
  })
})
