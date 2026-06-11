import { describe, it, expect } from 'vitest'
import { configDiff } from './configDiff'

describe('configDiff', () => {
  it('returns empty for identical configs', () => {
    const c = { cadenceHours: 6, datanets: { '2': { vote: true } } }
    expect(configDiff(c, c)).toEqual([])
  })

  it('reports leaf changes as old→new', () => {
    expect(configDiff({ budget: { mintReppoMax: 50 } }, { budget: { mintReppoMax: 500 } }))
      .toEqual(['budget.mintReppoMax 50→500'])
  })

  it('collapses added/removed subtrees to one line', () => {
    expect(configDiff({ datanets: {} }, { datanets: { '7': { vote: true, mint: false } } }))
      .toEqual(['datanets.7 added'])
    expect(configDiff({ datanets: { '7': { vote: true } } }, { datanets: {} }))
      .toEqual(['datanets.7 removed'])
  })

  it('skips the * wildcard key', () => {
    expect(configDiff({ datanets: { '*': { vote: true } } }, { datanets: { '*': { vote: false } } }))
      .toEqual([])
  })

  it('shows undefined as ∅ for added/removed leaves', () => {
    expect(configDiff({}, { cadenceHours: 6 })).toEqual(['cadenceHours ∅→6'])
    expect(configDiff({ cadenceHours: 6 }, {})).toEqual(['cadenceHours 6→∅'])
  })

  it('formats array changes', () => {
    expect(configDiff({ tags: [1, 2] }, { tags: [1, 3] })).toEqual(['tags [1,2]→[1,3]'])
  })
})
