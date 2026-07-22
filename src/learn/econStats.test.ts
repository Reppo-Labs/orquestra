import { describe, it, expect } from 'vitest'
import { computeEconStats } from './econStats.js'
import type { EconEpochRow } from './store.js'
import type { DatanetYield } from '../voter/yield.js'

const row = (over: Partial<EconEpochRow> = {}): EconEpochRow => ({
  datanetId: '9', epoch: 100, ownerClaimedReppo: 0, voterClaimedReppo: 0,
  mintCostReppo: 0, mintCount: 0, votesCast: 0, ...over,
})

describe('computeEconStats (pure)', () => {
  it('sums fields across rows and computes ROI', () => {
    const rows = [
      row({ epoch: 100, mintCostReppo: 100, mintCount: 2, ownerClaimedReppo: 80, voterClaimedReppo: 5, votesCast: 10 }),
      row({ epoch: 101, mintCostReppo: 50, mintCount: 1, ownerClaimedReppo: 20, voterClaimedReppo: 3, votesCast: 8 }),
    ]
    const stats = computeEconStats('9', rows)
    expect(stats.datanetId).toBe('9')
    expect(stats.epochsCovered).toBe(2)
    expect(stats.mintCostReppo).toBe(150)
    expect(stats.mintCount).toBe(3)
    expect(stats.ownerClaimedReppo).toBe(100)
    expect(stats.mintRoiPct).toBe(Math.round((100 / 150) * 100))
    expect(stats.voterClaimedReppo).toBe(8)
    expect(stats.votesCast).toBe(18)
    expect(stats.voterReppoPerVote).toBeCloseTo(8 / 18)
  })

  it('mintRoiPct is null when mint cost is 0', () => {
    const stats = computeEconStats('9', [row({ epoch: 100, ownerClaimedReppo: 50 })])
    expect(stats.mintRoiPct).toBeNull()
  })

  it('voterReppoPerVote is null when votesCast is 0', () => {
    const stats = computeEconStats('9', [row({ epoch: 100, voterClaimedReppo: 5, votesCast: 0 })])
    expect(stats.voterReppoPerVote).toBeNull()
  })

  it('empty rows → epochsCovered 0 and all-zero stats', () => {
    const stats = computeEconStats('9', [])
    expect(stats.epochsCovered).toBe(0)
    expect(stats.mintRoiPct).toBeNull()
    expect(stats.voterReppoPerVote).toBeNull()
    expect(stats.latestYieldPerVote).toBeNull()
    expect(stats.latestUncontested).toBe(false)
  })

  it('an all-zero row is NOT counted in epochsCovered', () => {
    const stats = computeEconStats('9', [row({ epoch: 100 }), row({ epoch: 101, mintCount: 1 })])
    expect(stats.epochsCovered).toBe(1)
  })

  it('passes through latestYieldPerVote/latestUncontested from the yield arg', () => {
    const yield_: DatanetYield = {
      datanetId: '9', emissionsPerEpochReppo: 10, epoch: 100, epochVoteVolume: 200,
      yieldPerVote: 0.05, uncontested: false,
      poolReppo: null, poolPrimaryToken: null, runwayEpochs: null, poolDry: false,
    }
    const stats = computeEconStats('9', [row({ epoch: 100, mintCount: 1 })], yield_)
    expect(stats.latestYieldPerVote).toBe(0.05)
    expect(stats.latestUncontested).toBe(false)
  })

  it('yield fields default to null/false when the yield arg is absent', () => {
    const stats = computeEconStats('9', [row({ epoch: 100, mintCount: 1 })])
    expect(stats.latestYieldPerVote).toBeNull()
    expect(stats.latestUncontested).toBe(false)
  })

  it('latestUncontested true passes through even when yieldPerVote is null', () => {
    const yield_: DatanetYield = {
      datanetId: '9', emissionsPerEpochReppo: 10, epoch: 100, epochVoteVolume: 0,
      yieldPerVote: null, uncontested: true,
      poolReppo: null, poolPrimaryToken: null, runwayEpochs: null, poolDry: false,
    }
    const stats = computeEconStats('9', [row({ epoch: 100, mintCount: 1 })], yield_)
    expect(stats.latestYieldPerVote).toBeNull()
    expect(stats.latestUncontested).toBe(true)
  })
})
