import { describe, it, expect } from 'vitest'
import { planStakeTopUp } from './stakeTopUp.js'

describe('planStakeTopUp', () => {
  it('locks the difference when the target exceeds current veREPPO', () => {
    expect(planStakeTopUp(1031, { lockReppo: 2000, lockDurationDays: 30 }))
      .toEqual({ lockAmount: 969, durationSeconds: 30 * 86400 })
  })
  it('locks the full target from zero (first lock)', () => {
    expect(planStakeTopUp(0, { lockReppo: 2000, lockDurationDays: 30 }))
      .toEqual({ lockAmount: 2000, durationSeconds: 30 * 86400 })
  })
  it('returns null when current is at or above target (incl. down-bump)', () => {
    expect(planStakeTopUp(2000, { lockReppo: 2000, lockDurationDays: 30 })).toBeNull()
    expect(planStakeTopUp(2500, { lockReppo: 2000, lockDurationDays: 30 })).toBeNull()
  })
  it('returns null when staking is not configured (target <= 0)', () => {
    expect(planStakeTopUp(0, { lockReppo: 0, lockDurationDays: 30 })).toBeNull()
  })
})
