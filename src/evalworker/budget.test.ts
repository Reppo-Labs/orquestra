import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvalBudget } from './budget.js'

const file = () => join(mkdtempSync(join(tmpdir(), 'evalbudget-')), 'b.json')

describe('EvalBudget', () => {
  it('reserves until the cap, then refuses', () => {
    const b = new EvalBudget(file(), () => 2)
    expect(b.reserve()).toBe(true)
    expect(b.reserve()).toBe(true)
    expect(b.reserve()).toBe(false)
    expect(b.usedToday()).toBe(2)
  })

  it('survives restart (persisted count)', () => {
    const f = file()
    const a = new EvalBudget(f, () => 3)
    a.reserve()
    a.reserve()
    const b = new EvalBudget(f, () => 3)
    expect(b.usedToday()).toBe(2)
    expect(b.reserve()).toBe(true)
    expect(b.reserve()).toBe(false)
  })

  it('resets when the UTC day rolls over', () => {
    let now = Date.parse('2026-08-26T23:59:00Z')
    const b = new EvalBudget(file(), () => 1, () => now)
    expect(b.reserve()).toBe(true)
    expect(b.reserve()).toBe(false)
    now = Date.parse('2026-08-27T00:01:00Z')
    expect(b.reserve()).toBe(true)
  })

  it('cap reads live (hot-reloaded config can raise it mid-day)', () => {
    let cap = 1
    const b = new EvalBudget(file(), () => cap)
    expect(b.reserve()).toBe(true)
    expect(b.reserve()).toBe(false)
    cap = 3
    expect(b.reserve()).toBe(true)
  })

  it('self-heals a corrupt file to a fresh day', () => {
    const f = file()
    writeFileSync(f, 'not json{{')
    const b = new EvalBudget(f, () => 2)
    expect(b.usedToday()).toBe(0)
    expect(b.reserve()).toBe(true)
  })
  it('release() gives back a reservation the caller never spent (round-trip)', () => {
    const f = file()
    const b = new EvalBudget(f, () => 2)
    expect(b.reserve()).toBe(true)
    expect(b.usedToday()).toBe(1)
    b.release()
    expect(b.usedToday()).toBe(0)
    // persisted, not just in memory
    expect(new EvalBudget(f, () => 2).usedToday()).toBe(0)
    expect(b.reserve()).toBe(true)
    expect(b.reserve()).toBe(true)
    expect(b.reserve()).toBe(false)
  })

  it('a double release floors at 0 (never manufactures budget)', () => {
    const b = new EvalBudget(file(), () => 2)
    b.reserve()
    b.release()
    b.release()
    b.release()
    expect(b.usedToday()).toBe(0)
  })

  it('release survives a corrupt file the same way reserve does', () => {
    const f = file()
    writeFileSync(f, 'not json{{')
    const b = new EvalBudget(f, () => 2)
    expect(b.reserve()).toBe(true)
    b.release()
    expect(b.usedToday()).toBe(0)
  })
})
