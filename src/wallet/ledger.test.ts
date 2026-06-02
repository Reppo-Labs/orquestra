// src/wallet/ledger.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BudgetLedger, LedgerCorruptError } from './ledger.js'

const caps = { voteGasEthMax: 0.05, voteRateMaxPerCycle: 3, mintReppoMax: 100, mintGasEthMax: 0.1 }
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
    expect(b.canMint(40)).toBe(false) // 70 + 40 > 100, loaded from disk
    expect(existsSync(join(dir, 'budget-ledger.json'))).toBe(true)
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

  // --- atomic write: no .tmp file left behind ---

  it('save() leaves no .tmp file behind', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    l.reserveVote(0.001)
    const files = readdirSync(dir)
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false)
    expect(files).toContain('budget-ledger.json')
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
