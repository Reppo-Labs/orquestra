// src/wallet/ledger.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BudgetLedger, LedgerCorruptError, type BudgetCaps } from './ledger.js'

const caps = { voteGasEthMax: 0.05, voteRateMaxPerCycle: 3, mintReppoMax: 100, mintGasEthMax: 0.1, claimGasEthMax: 0.01 }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-led-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('BudgetLedger', () => {
  // --- core cap enforcement ---

  it('allows votes until the per-cycle rate cap, then refuses', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    expect(l.canVote()).toBe(true)
    l.reserveVote(0.001); l.reserveVote(0.001); l.reserveVote(0.001) // 3 = cap
    expect(l.canVote()).toBe(false)
  })

  it('reports the votes remaining in the per-cycle rate cap', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    expect(l.votesRemaining()).toBe(3)
    l.reserveVote(0.001)
    expect(l.votesRemaining()).toBe(2)
    l.reserveVote(0.001); l.reserveVote(0.001)
    expect(l.votesRemaining()).toBe(0) // never negative
  })

  it('reports 0 votes remaining once the gas cap is hit, even if the rate cap has headroom', () => {
    // rate cap 99 (ample), but gas cap is the binding constraint.
    const l = new BudgetLedger(dir, { ...caps, voteGasEthMax: 0.0025, voteRateMaxPerCycle: 99 })
    l.startCycle('c1'); l.reserveVote(0.001); l.reserveVote(0.001)
    expect(l.canVote()).toBe(true)
    expect(l.votesRemaining()).toBe(97) // rate headroom while gas still allows
    l.reserveVote(0.001) // cumulative 0.003 > 0.0025 → gas exhausted
    expect(l.canVote()).toBe(false)
    expect(l.votesRemaining()).toBe(0) // must not overstate: no more votes are castable
  })

  it('resets the per-cycle vote count on a new cycle but keeps cumulative gas', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1'); l.reserveVote(0.001); l.reserveVote(0.001); l.reserveVote(0.001)
    expect(l.canVote()).toBe(false)
    l.startCycle('c2')
    expect(l.canVote()).toBe(true)
    expect(l.state.voteGasSpentEth).toBeCloseTo(0.003)
  })

  it('refuses votes once cumulative vote-gas cap is hit (across cycles)', () => {
    const l = new BudgetLedger(dir, { ...caps, voteGasEthMax: 0.0025, voteRateMaxPerCycle: 99 })
    l.startCycle('c1'); l.reserveVote(0.001); l.reserveVote(0.001)
    expect(l.canVote()).toBe(true)
    l.reserveVote(0.001) // cumulative 0.003 > 0.0025
    expect(l.canVote()).toBe(false)
  })

  it('refuses a mint that would exceed the REPPO cap', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    expect(l.canMint(60)).toBe(true)
    l.reserveMint(60, 0.01)
    expect(l.canMint(60)).toBe(false) // 60 + 60 > 100
    expect(l.canMint(40)).toBe(true)  // 60 + 40 = 100, ok
  })

  it('refuses mints once cumulative mint-gas cap is hit', () => {
    const l = new BudgetLedger(dir, { ...caps, mintGasEthMax: 0.015 })
    l.startCycle('c1'); l.reserveMint(1, 0.01)
    expect(l.canMint(1)).toBe(true)
    l.reserveMint(1, 0.01) // gas 0.02 > 0.015
    expect(l.canMint(1)).toBe(false)
  })

  it('persists across reload (caps survive a restart)', () => {
    const a = new BudgetLedger(dir, caps)
    a.startCycle('c1'); a.reserveMint(70, 0.01)
    const b = new BudgetLedger(dir, caps) // fresh instance, same dir
    expect(b.canMint(40)).toBe(false) // 70 + 40 > 100, loaded from the DB
    expect(existsSync(join(dir, 'budget-ledger.json'))).toBe(false) // persisted in SQLite, not JSON
    expect(existsSync(join(dir, 'activity.db'))).toBe(true)
  })

  // --- crash-safety: reservation persists before sign ---

  it('crash-safety: after reserveVote, a new BudgetLedger over the same dir sees the debit already persisted', () => {
    const a = new BudgetLedger(dir, caps)
    a.startCycle('c1')
    a.reserveVote(0.001)
    // Simulate crash: construct a new instance from the persisted state
    const b = new BudgetLedger(dir, caps)
    expect(b.state.votesCastThisCycle).toBe(1)
    expect(b.state.voteGasSpentEth).toBeCloseTo(0.001)
  })

  it('crash-safety: after reserveMint, a new BudgetLedger over the same dir sees the debit already persisted', () => {
    const a = new BudgetLedger(dir, caps)
    a.startCycle('c1')
    a.reserveMint(50, 0.01)
    const b = new BudgetLedger(dir, caps)
    expect(b.state.mintReppoSpent).toBe(50)
    expect(b.state.mintGasSpentEth).toBeCloseTo(0.01)
  })

  // --- reconcile adjusts to actual gas ---

  it('reconcileVote adjusts gas to actual', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    const res = l.reserveVote(0.003)!
    // Actual gas was 0.001 (less than estimate)
    l.reconcileVote(res, 0.001)
    expect(l.state.voteGasSpentEth).toBeCloseTo(0.001)
  })

  it('reconcileVote clamps to zero if actual gas makes total go negative', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    const res = l.reserveVote(0.003)!
    // Actual gas is 0 — delta is -0.003, clamped to 0
    l.reconcileVote(res, 0)
    expect(l.state.voteGasSpentEth).toBeGreaterThanOrEqual(0)
  })

  it('reconcileMint adjusts gas to actual', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    const res = l.reserveMint(50, 0.02)!
    l.reconcileMint(res, 0.015)
    expect(l.state.mintGasSpentEth).toBeCloseTo(0.015)
  })

  // --- release rolls back the debit ---

  it('releaseVote rolls back vote count and gas (and never goes negative)', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    const res = l.reserveVote(0.001)!
    expect(l.state.votesCastThisCycle).toBe(1)
    l.releaseVote(res)
    expect(l.state.votesCastThisCycle).toBe(0)
    expect(l.state.voteGasSpentEth).toBeCloseTo(0)
  })

  it('releaseVote never makes counters negative', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    // Manually craft a double-release scenario
    const res = l.reserveVote(0.001)!
    l.releaseVote(res)
    l.releaseVote(res) // second release on already-zero counters
    expect(l.state.votesCastThisCycle).toBeGreaterThanOrEqual(0)
    expect(l.state.voteGasSpentEth).toBeGreaterThanOrEqual(0)
  })

  it('releaseMint rolls back REPPO and gas (and never goes negative)', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    const res = l.reserveMint(50, 0.01)!
    l.releaseMint(res)
    expect(l.state.mintReppoSpent).toBe(0)
    expect(l.state.mintGasSpentEth).toBeCloseTo(0)
  })

  // --- fail-closed on corrupt ledger ---

  it('throws LedgerCorruptError when the ledger file contains invalid JSON (fail closed, NOT reset to zero)', () => {
    writeFileSync(join(dir, 'budget-ledger.json'), '{ not json')
    expect(() => new BudgetLedger(dir, caps)).toThrowError(LedgerCorruptError)
  })

  it('throws LedgerCorruptError when the ledger has a negative counter (fail closed)', () => {
    writeFileSync(join(dir, 'budget-ledger.json'), JSON.stringify({
      cycleId: 'c1', votesCastThisCycle: -1, voteGasSpentEth: 0, mintReppoSpent: 0, mintGasSpentEth: 0
    }))
    expect(() => new BudgetLedger(dir, caps)).toThrowError(LedgerCorruptError)
  })

  it('throws LedgerCorruptError when the ledger has a non-finite number', () => {
    writeFileSync(join(dir, 'budget-ledger.json'), JSON.stringify({
      cycleId: 'c1', votesCastThisCycle: Infinity, voteGasSpentEth: 0, mintReppoSpent: 0, mintGasSpentEth: 0
    }))
    expect(() => new BudgetLedger(dir, caps)).toThrowError(LedgerCorruptError)
  })

  it('imports a legacy budget-ledger.json once, then renames it .imported', () => {
    writeFileSync(join(dir, 'budget-ledger.json'), JSON.stringify({
      cycleId: 'c1', votesCastThisCycle: 2, voteGasSpentEth: 0.002, mintReppoSpent: 70,
      mintGasSpentEth: 0.01, claimGasSpentEth: 0,
    }))
    const l = new BudgetLedger(dir, caps)
    expect(l.state.mintReppoSpent).toBe(70)
    expect(l.state.votesCastThisCycle).toBe(2)
    expect(existsSync(join(dir, 'budget-ledger.json'))).toBe(false)
    expect(existsSync(join(dir, 'budget-ledger.json.imported'))).toBe(true)
  })

  it('loads a legacy ledger with the removed grantReppoSpent field without throwing (ignored)', () => {
    writeFileSync(join(dir, 'budget-ledger.json'), JSON.stringify({
      cycleId: 'c1', votesCastThisCycle: 1, voteGasSpentEth: 0.001, mintReppoSpent: 40,
      mintGasSpentEth: 0.005, claimGasSpentEth: 0, grantReppoSpent: 123,
    }))
    const l = new BudgetLedger(dir, caps)
    expect(l.state.mintReppoSpent).toBe(40)
    expect((l.state as Record<string, unknown>).grantReppoSpent).toBeUndefined()
  })

  // --- atomic write: no .tmp file left behind ---

  it('save() persists to the SQLite DB, leaving no .tmp or JSON file behind', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    l.reserveVote(0.001)
    const files = readdirSync(dir)
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false)
    expect(files).not.toContain('budget-ledger.json')
    expect(files).toContain('activity.db')
  })

  // --- reserveVote returns null when over budget ---

  it('reserveVote returns null when over-budget (no debit)', () => {
    const l = new BudgetLedger(dir, { ...caps, voteRateMaxPerCycle: 1 })
    l.startCycle('c1')
    l.reserveVote(0.001) // fills the cap
    const res = l.reserveVote(0.001)
    expect(res).toBeNull()
    expect(l.state.votesCastThisCycle).toBe(1) // not incremented
  })

  it('reserveMint returns null when over-budget (no debit)', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    const res = l.reserveMint(150, 0.01) // 150 > 100 cap
    expect(res).toBeNull()
    expect(l.state.mintReppoSpent).toBe(0) // not incremented
  })
})

const CAPS: BudgetCaps = {
  voteGasEthMax: 0.05, voteRateMaxPerCycle: 30, mintReppoMax: 500, mintGasEthMax: 0.05, claimGasEthMax: 0.01,
}

describe('BudgetLedger claim gas cap', () => {
  it('reserves, reconciles to actual, and persists claimGasSpentEth', () => {
    const l = new BudgetLedger(dir, CAPS)
    const res = l.reserveClaim(0.003)!
    expect(res).not.toBeNull()
    l.reconcileClaim(res, 0.004) // actual higher than est
    expect(l.state.claimGasSpentEth).toBeCloseTo(0.004)
  })

  it('refuses once claimGasEthMax is reached', () => {
    const l = new BudgetLedger(dir, CAPS)
    const a = l.reserveClaim(0.006); expect(a).not.toBeNull()
    const b = l.reserveClaim(0.006) // 0.012 > 0.01 cap
    expect(b).toBeNull()
  })

  it('release rolls back a reservation', () => {
    const l = new BudgetLedger(dir, CAPS)
    const res = l.reserveClaim(0.004)!
    l.releaseClaim(res)
    expect(l.state.claimGasSpentEth).toBeCloseTo(0)
  })
})

describe('BudgetLedger.updateCaps (config hot-reload)', () => {
  it('swaps ceilings without touching spent counters', () => {
    const l = new BudgetLedger(dir, { ...CAPS, mintReppoMax: 10 })
    const r = l.reserveMint(8, 0.001)
    expect(r).not.toBeNull()
    expect(l.reserveMint(8, 0.001)).toBeNull()      // 8+8 > 10
    l.updateCaps({ ...CAPS, mintReppoMax: 100 })
    expect(l.reserveMint(8, 0.001)).not.toBeNull()  // new ceiling applies, spend kept
    expect(l.state.mintReppoSpent).toBe(16)
  })
})

describe('BudgetLedger actual-REPPO reconciliation', () => {
  it('reconcileMint adjusts mintReppoSpent to the ACTUAL fee (est 0 → actual 100)', () => {
    const l = new BudgetLedger(dir, { ...CAPS, mintReppoMax: 150 })
    const r = l.reserveMint(0, 0.001)!
    l.reconcileMint(r, 0.0005, 100)            // actual fee reported by the CLI
    expect(l.state.mintReppoSpent).toBe(100)
    // retrospective cap: once actuals exceed the cap, further mints refuse
    const r2 = l.reserveMint(0, 0.001)!
    l.reconcileMint(r2, 0.0005, 100)           // total 200 > 150
    expect(l.reserveMint(0, 0.001)).toBeNull()
  })
})

describe('BudgetLedger horizon window (caps are per-horizon, not lifetime)', () => {
  const iso = (d: string) => `${d}T00:00:00.000Z`

  it('resets cumulative spend when horizonDays elapse, keeping caps within-window', () => {
    const l = new BudgetLedger(dir, CAPS, 30) // 30-day horizon
    l.startCycle(iso('2026-06-01'))            // seeds horizonStart
    l.reserveMint(300, 0.01)
    expect(l.state.mintReppoSpent).toBe(300)
    l.startCycle(iso('2026-06-20'))            // 19 days — same window, no reset
    expect(l.state.mintReppoSpent).toBe(300)
    l.startCycle(iso('2026-07-05'))            // 34 days from start — window rolled
    expect(l.state.mintReppoSpent).toBe(0)
  })

  it('horizonDays = 0 (or default) never rolls — lifetime cumulative', () => {
    const l = new BudgetLedger(dir, CAPS) // no horizon
    l.startCycle(iso('2026-06-01'))
    l.reserveMint(300, 0.01)
    l.startCycle(iso('2027-06-01')) // a year later — still cumulative
    expect(l.state.mintReppoSpent).toBe(300)
  })

  it('a non-timestamp cycleId never triggers a rollover (tests / odd ids)', () => {
    const l = new BudgetLedger(dir, CAPS, 1)
    l.startCycle('c1'); l.reserveMint(50, 0.01)
    l.startCycle('c2')
    expect(l.state.mintReppoSpent).toBe(50)
  })

  it('updateHorizonDays hot-reloads the window length', () => {
    const l = new BudgetLedger(dir, CAPS, 0)
    l.startCycle(iso('2026-06-01')); l.reserveMint(300, 0.01)
    l.updateHorizonDays(10)
    l.startCycle(iso('2026-06-02')) // seeds horizonStart now that horizon is active
    l.startCycle(iso('2026-06-20')) // 18 days later → rolled
    expect(l.state.mintReppoSpent).toBe(0)
  })
})
