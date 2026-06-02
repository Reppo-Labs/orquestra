// src/wallet/ledger.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BudgetLedger } from './ledger.js'

const caps = { voteGasEthMax: 0.05, voteRateMaxPerCycle: 3, mintReppoMax: 100, mintGasEthMax: 0.1 }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-led-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('BudgetLedger', () => {
  it('allows votes until the per-cycle rate cap, then refuses', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    expect(l.canVote()).toBe(true)
    l.recordVote(0.001); l.recordVote(0.001); l.recordVote(0.001) // 3 = cap
    expect(l.canVote()).toBe(false)
  })

  it('resets the per-cycle vote count on a new cycle but keeps cumulative gas', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1'); l.recordVote(0.001); l.recordVote(0.001); l.recordVote(0.001)
    expect(l.canVote()).toBe(false)
    l.startCycle('c2')
    expect(l.canVote()).toBe(true)
    expect(l.state.voteGasSpentEth).toBeCloseTo(0.003)
  })

  it('refuses votes once cumulative vote-gas cap is hit (across cycles)', () => {
    const l = new BudgetLedger(dir, { ...caps, voteGasEthMax: 0.0025, voteRateMaxPerCycle: 99 })
    l.startCycle('c1'); l.recordVote(0.001); l.recordVote(0.001)
    expect(l.canVote()).toBe(true)
    l.recordVote(0.001) // cumulative 0.003 > 0.0025
    expect(l.canVote()).toBe(false)
  })

  it('refuses a mint that would exceed the REPPO cap', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    expect(l.canMint(60)).toBe(true)
    l.recordMint(60, 0.01)
    expect(l.canMint(60)).toBe(false) // 60 + 60 > 100
    expect(l.canMint(40)).toBe(true)  // 60 + 40 = 100, ok
  })

  it('refuses mints once cumulative mint-gas cap is hit', () => {
    const l = new BudgetLedger(dir, { ...caps, mintGasEthMax: 0.015 })
    l.startCycle('c1'); l.recordMint(1, 0.01)
    expect(l.canMint(1)).toBe(true)
    l.recordMint(1, 0.01) // gas 0.02 > 0.015
    expect(l.canMint(1)).toBe(false)
  })

  it('persists across reload (caps survive a restart)', () => {
    const a = new BudgetLedger(dir, caps)
    a.startCycle('c1'); a.recordMint(70, 0.01)
    const b = new BudgetLedger(dir, caps) // fresh instance, same dir
    expect(b.canMint(40)).toBe(false) // 70 + 40 > 100, loaded from disk
    expect(existsSync(join(dir, 'budget-ledger.json'))).toBe(true)
  })
})
