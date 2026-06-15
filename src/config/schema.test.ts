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
    expect(parsed.datanets['*']).toEqual({ vote: false, mint: false, strictness: 'balanced', mintMode: 'pin' })
  })

  it('rejects an unknown strictness', () => {
    const bad = { ...valid, datanets: { '9': { vote: true, strictness: 'reckless' } } }
    expect(() => StrategyConfigSchema.parse(bad)).toThrow()
  })

  it('rejects a non-positive horizon', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, horizonDays: 0 })).toThrow()
  })

  it('accepts a fractional cadence (0.3h = 18 min) but rejects below the 0.1h floor', () => {
    expect(StrategyConfigSchema.parse({ ...valid, cadenceHours: 0.3 }).cadenceHours).toBe(0.3)
    expect(() => StrategyConfigSchema.parse({ ...valid, cadenceHours: 0.05 })).toThrow()
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
  it('defaults gas caps high when absent (gas no longer operator-configured)', () => {
    const cfg = StrategyConfigSchema.parse({ ...valid, budget: { voteRateMaxPerCycle: 25, mintReppoMax: 100 } })
    expect(cfg.budget.voteGasEthMax).toBe(1)
    expect(cfg.budget.mintGasEthMax).toBe(1)
    expect(cfg.budget.claimGasEthMax).toBe(1)
  })
  it('accepts claimEmissions:false', () => {
    expect(StrategyConfigSchema.parse({ ...valid, claimEmissions: false }).claimEmissions).toBe(false)
  })
})

describe('StrategyConfig deliberation', () => {
  it('defaults deliberation for legacy configs (enabled, votePanel true)', () => {
    expect(StrategyConfigSchema.parse(valid).deliberation).toEqual({ enabled: true, votePanel: true })
  })
  it('accepts explicit deliberation settings', () => {
    const cfg = StrategyConfigSchema.parse({ ...valid, deliberation: { enabled: false, votePanel: false } })
    expect(cfg.deliberation).toEqual({ enabled: false, votePanel: false })
  })
  it('strips a legacy voteBand and defaults votePanel (migration)', () => {
    const cfg = StrategyConfigSchema.parse({ ...valid, deliberation: { enabled: true, voteBand: 1 } })
    expect(cfg.deliberation).toEqual({ enabled: true, votePanel: true })
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
