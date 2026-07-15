import { describe, it, expect } from 'vitest'
import { PAIR_REGISTRY, filterPairs } from './pairs.js'

describe('PAIR_REGISTRY', () => {
  it('has unique ids and complete rows', () => {
    const ids = PAIR_REGISTRY.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of PAIR_REGISTRY) {
      expect(p.tokenId).toBeTruthy()
      expect(p.referenceTicker).toBeTruthy()
      expect(p.referenceSymbol).toBeTruthy()
      expect(['metal', 'equity']).toContain(p.class)
    }
  })
  it('always contains the gold pairs', () => {
    expect(PAIR_REGISTRY.some((p) => p.id === 'paxg-gold')).toBe(true)
    expect(PAIR_REGISTRY.some((p) => p.id === 'xaut-gold')).toBe(true)
  })
})

describe('filterPairs', () => {
  it('no focus → all pairs', () => {
    expect(filterPairs(PAIR_REGISTRY, undefined)).toHaveLength(PAIR_REGISTRY.length)
  })
  it('matches class aliases case-insensitively', () => {
    expect(filterPairs(PAIR_REGISTRY, 'Gold').every((p) => p.class === 'metal')).toBe(true)
    for (const p of filterPairs(PAIR_REGISTRY, 'stocks')) expect(p.class).toBe('equity')
  })
  it('matches token symbol', () => {
    const hits = filterPairs(PAIR_REGISTRY, 'PAXG')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.id).toBe('paxg-gold')
  })
  it('unmatched focus → empty', () => {
    expect(filterPairs(PAIR_REGISTRY, 'zzz-nonexistent')).toHaveLength(0)
  })
})
