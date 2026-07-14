// src/runtime/setupStake.test.ts
// The startup veREPPO lock is the ONE signing path that does not run through runCycle's
// pause gate — and it is the one the BudgetLedger does not cap (locks are not a ledger
// spend category). These tests pin that `paused` refuses it BEFORE executor.lock is called.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupStake, type StakeSetupDeps } from './setupStake.js'
import { markStakeTargetAttempted, wasStakeTargetAttempted } from '../wallet/stakeTopUp.js'

const stake = { lockReppo: 5000, lockDurationDays: 30 }

type TestDeps = StakeSetupDeps & { lock: ReturnType<typeof vi.fn> }

function deps(over: Partial<StakeSetupDeps> = {}): TestDeps {
  const lock = vi.fn(async () => ({ status: 'executed' as const, txHash: '0xabc' }))
  return { getVeReppo: async () => 0, lock, log: () => {}, ...over } as TestDeps
}

beforeEach(() => {
  // The attempted-target latch is module-global process state; reset it between cases.
  markStakeTargetAttempted(-1)
})

describe('setupStake — the pause gate covers the startup lock', () => {
  it('REFUSES to sign a startup lock while the node is paused (the restart-while-paused case)', async () => {
    const d = deps()
    const logs: string[] = []
    await setupStake({ paused: true, stake }, { ...d, log: (m) => logs.push(m) })
    expect(d.lock).not.toHaveBeenCalled()
    expect(logs.join('\n')).toMatch(/paused/i)
  })

  it('does not read the balance or latch the target while paused — unpausing resumes the top-up', async () => {
    const getVeReppo = vi.fn(async () => 0)
    const d = deps({ getVeReppo })
    await setupStake({ paused: true, stake }, d)
    expect(getVeReppo).not.toHaveBeenCalled()
    expect(wasStakeTargetAttempted(stake.lockReppo)).toBe(false)

    // unpaused: the same config now locks
    await setupStake({ paused: false, stake }, d)
    expect(d.lock).toHaveBeenCalledWith({ amountReppo: 5000, durationSeconds: 30 * 86400, idempotencyKey: expect.any(String) })
  })

  it('locks the gap to target when unpaused', async () => {
    const d = deps({ getVeReppo: async () => 1000 })
    await setupStake({ paused: false, stake }, d)
    expect(d.lock).toHaveBeenCalledWith({ amountReppo: 4000, durationSeconds: 30 * 86400, idempotencyKey: expect.any(String) })
    expect(wasStakeTargetAttempted(5000)).toBe(true) // latched on a confirmed lock
  })

  it('never locks against an unreadable balance (a failed read is not zero)', async () => {
    const d = deps({ getVeReppo: async () => null })
    await setupStake({ paused: false, stake }, d)
    expect(d.lock).not.toHaveBeenCalled()
  })

  it('does not latch a FAILED lock — the per-cycle top-up retries it', async () => {
    const d = deps({ lock: vi.fn(async () => ({ status: 'error' as const, detail: 'INSUFFICIENT_REPPO_BALANCE' })) })
    await setupStake({ paused: false, stake }, d)
    expect(wasStakeTargetAttempted(5000)).toBe(false)
  })

  it('no-ops (and latches) when veREPPO is already at target', async () => {
    const d = deps({ getVeReppo: async () => 5000 })
    await setupStake({ paused: false, stake }, d)
    expect(d.lock).not.toHaveBeenCalled()
    expect(wasStakeTargetAttempted(5000)).toBe(true)
  })

  it('no-ops when staking is off (lockReppo 0)', async () => {
    const d = deps()
    await setupStake({ paused: false, stake: { lockReppo: 0, lockDurationDays: 30 } }, d)
    expect(d.lock).not.toHaveBeenCalled()
  })
})
