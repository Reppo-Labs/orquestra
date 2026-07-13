import { describe, expect, it } from 'vitest'
import { deepEqual, merge3 } from './merge3'

// The config is written by more than one writer: the dashboard, POST /api/pause, and the
// learning proposals the operator accepts in Diagnostics. A dashboard Save is a FULL replace,
// so without a rebase it reverts every one of those writes to whatever the tab held at page
// load. These tests are that rebase.

const base = {
  paused: false,
  claimEmissions: true,
  budget: { mintReppoMax: 3000, voteGasEthMax: 0.02 },
  datanets: {
    '2': { vote: true, mint: true, strictness: 'balanced' },
    '3': { vote: true, mint: false, strictness: 'aggressive' },
  },
}
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('merge3', () => {
  it('adopts a server change the operator never touched', () => {
    // 09:00 page load. 09:20: the operator accepts a learning proposal in Diagnostics and the
    // NODE writes datanet 3 → conservative. 09:25 they save an unrelated edit. Without this,
    // that Save silently reverts datanet 3 to aggressive.
    const mine = copy(base)
    mine.datanets['2'].mint = false // their edit, elsewhere
    const theirs = copy(base)
    theirs.datanets['3'].strictness = 'conservative'

    const out = merge3(base, mine, theirs) as typeof base
    expect(out.datanets['3'].strictness).toBe('conservative') // the node's write survives
    expect(out.datanets['2'].mint).toBe(false) // and so does the operator's
  })

  it('never lets a stale candidate un-pause the node', () => {
    const theirs = { ...base, paused: true } // POST /api/pause, from another tab
    const mine = copy(base) // this tab knows nothing about it
    expect((merge3(base, mine, theirs) as typeof base).paused).toBe(true)
  })

  it('keeps the operator edit when the server did not touch that field', () => {
    const mine = { ...base, budget: { ...base.budget, mintReppoMax: 500 } }
    expect((merge3(base, mine, base) as typeof base).budget.mintReppoMax).toBe(500)
  })

  it('keeps the operator edit on a genuine conflict — never silently overwrite what they typed', () => {
    const mine = { ...base, budget: { ...base.budget, mintReppoMax: 500 } }
    const theirs = { ...base, budget: { ...base.budget, mintReppoMax: 1000 } }
    expect((merge3(base, mine, theirs) as typeof base).budget.mintReppoMax).toBe(500)
  })

  it('honours a deletion by either side', () => {
    const mine = copy(base)
    delete (mine.datanets as Record<string, unknown>)['3'] // "remove this datanet"
    const theirs = copy(base) as typeof base & { datanets: Record<string, unknown> }
    theirs.datanets['9'] = { vote: true, mint: false, strictness: 'balanced' } // added elsewhere

    const out = merge3(base, mine, theirs) as typeof base & { datanets: Record<string, unknown> }
    expect(out.datanets['3']).toBeUndefined()
    expect(out.datanets['9']).toBeDefined()
  })

  it('is a no-op when nothing changed anywhere', () => {
    expect(merge3(base, base, base)).toEqual(base)
  })
})

describe('deepEqual', () => {
  it('compares structurally, not by reference', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false) // an explicit key is a key
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
  })
})
