// src/config/schema.test.ts
import { describe, it, expect } from 'vitest'
import { StrategyConfigSchema, STRICTNESS_THRESHOLDS } from './schema.js'

const valid = {
  horizonDays: 30,
  cadenceHours: 6,
  stake: { lockReppo: 500, lockDurationDays: 30 },
  budget: { voteGasEthMax: 0.02, voteRateMaxPerCycle: 25, mintReppoMax: 100, mintGasEthMax: 0.05, claimGasEthMax: 0.05 },
  datanets: { '9': { vote: true, mint: true, strictness: 'conservative', adapter: 'hyperliquid' } },
  notes: 'be picky',
}

describe('StrategyConfigSchema', () => {
  it('accepts a valid config and applies the wildcard default', () => {
    const parsed = StrategyConfigSchema.parse(valid)
    expect(parsed.datanets['9'].strictness).toBe('conservative')
    expect(parsed.datanets['*']).toEqual({ vote: false, mint: false, strictness: 'balanced' })
  })

  it('rejects an unknown strictness', () => {
    const bad = { ...valid, datanets: { '9': { vote: true, strictness: 'reckless' } } }
    expect(() => StrategyConfigSchema.parse(bad)).toThrow()
  })

  it('rejects a non-positive horizon', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, horizonDays: 0 })).toThrow()
  })

  it('exposes like/dislike thresholds per strictness on the 1-10 scale', () => {
    expect(STRICTNESS_THRESHOLDS.conservative).toEqual({ like: 8, dislike: 4 })
    expect(STRICTNESS_THRESHOLDS.aggressive.like).toBeLessThan(STRICTNESS_THRESHOLDS.conservative.like)
  })
})

describe('StrategyConfig claim fields', () => {
  it('defaults claimEmissions to true', () => {
    expect(StrategyConfigSchema.parse(valid).claimEmissions).toBe(true)
  })
  it('defaults claimGasEthMax when absent (back-compat for pre-existing configs)', () => {
    const { claimGasEthMax, ...partialBudget } = valid.budget
    const cfg = StrategyConfigSchema.parse({ ...valid, budget: partialBudget })
    expect(cfg.budget.claimGasEthMax).toBe(0.05)
  })
  it('accepts claimEmissions:false', () => {
    expect(StrategyConfigSchema.parse({ ...valid, claimEmissions: false }).claimEmissions).toBe(false)
  })
})

describe('StrategyConfig deliberation', () => {
  it('defaults deliberation for legacy configs (enabled, voteBand 1)', () => {
    expect(StrategyConfigSchema.parse(valid).deliberation).toEqual({ enabled: true, voteBand: 1 })
  })
  it('accepts explicit deliberation settings', () => {
    const cfg = StrategyConfigSchema.parse({ ...valid, deliberation: { enabled: false, voteBand: 0 } })
    expect(cfg.deliberation).toEqual({ enabled: false, voteBand: 0 })
  })
  it('rejects an out-of-range voteBand', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, deliberation: { voteBand: 9 } })).toThrow()
  })
})

describe('StrategyConfig deliberation', () => {
  it('defaults deliberation for legacy configs (enabled, voteBand 1)', () => {
    expect(StrategyConfigSchema.parse(valid).deliberation).toEqual({ enabled: true, voteBand: 1 })
  })
  it('accepts explicit deliberation settings', () => {
    const cfg = StrategyConfigSchema.parse({ ...valid, deliberation: { enabled: false, voteBand: 0 } })
    expect(cfg.deliberation).toEqual({ enabled: false, voteBand: 0 })
  })
  it('rejects an out-of-range voteBand', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, deliberation: { voteBand: 9 } })).toThrow()
  })
})

describe('StrategyConfig adapterParams', () => {
  it('accepts optional adapterParams on a datanet policy', () => {
    const cfg = StrategyConfigSchema.parse({
      ...valid,
      datanets: { '2': { vote: true, mint: true, strictness: 'balanced', adapter: 'gdelt', adapterParams: { focus: 'ME', angle: 'contrarian', brief: 'b', topN: 5, minImportance: 7 } } },
    })
    const p = cfg.datanets['2'] as { adapterParams?: { focus?: string } }
    expect(p.adapterParams?.focus).toBe('ME')
  })
  it('datanets without adapterParams still parse', () => {
    expect(StrategyConfigSchema.parse(valid).datanets['9'].strictness).toBe('conservative')
  })
})
