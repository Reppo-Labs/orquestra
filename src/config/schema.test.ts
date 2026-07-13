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
    expect(parsed.datanets['*']).toEqual({ vote: false, mint: false, strictness: 'balanced', mintMode: 'pin', voteShare: 1 })
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

describe('StrategyConfig budget/stake ceilings (caps are the real security boundary)', () => {
  it('rejects mintReppoMax above the 1M ceiling, accepts at the ceiling', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintReppoMax: 1_000_001 } })).toThrow()
    expect(StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintReppoMax: 1_000_000 } }).budget.mintReppoMax).toBe(1_000_000)
  })
  it('rejects voteRateMaxPerCycle above the 1000 ceiling, accepts at the ceiling', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, voteRateMaxPerCycle: 1_001 } })).toThrow()
    expect(StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, voteRateMaxPerCycle: 1_000 } }).budget.voteRateMaxPerCycle).toBe(1_000)
  })
  it('rejects mintRateMaxPerCycle above the 1000 ceiling', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintRateMaxPerCycle: 1_001 } })).toThrow()
  })
  it('rejects gas caps above the 10 ETH ceiling (all three)', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, voteGasEthMax: 11 } })).toThrow()
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintGasEthMax: 11 } })).toThrow()
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, claimGasEthMax: 11 } })).toThrow()
  })
  it('rejects stake.lockReppo above the 10M ceiling, accepts at the ceiling', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, stake: { ...valid.stake, lockReppo: 10_000_001 } })).toThrow()
    expect(StrategyConfigSchema.parse({ ...valid, stake: { ...valid.stake, lockReppo: 10_000_000 } }).stake.lockReppo).toBe(10_000_000)
  })
  it('rejects an Infinity cap (cannot unbound the wallet)', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintReppoMax: Infinity } })).toThrow()
  })
})

describe('StrategyConfig budget/stake ceilings (caps are the real security boundary)', () => {
  it('rejects mintReppoMax above the 1M ceiling, accepts at the ceiling', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintReppoMax: 1_000_001 } })).toThrow()
    expect(StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintReppoMax: 1_000_000 } }).budget.mintReppoMax).toBe(1_000_000)
  })
  it('rejects voteRateMaxPerCycle above the 1000 ceiling, accepts at the ceiling', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, voteRateMaxPerCycle: 1_001 } })).toThrow()
    expect(StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, voteRateMaxPerCycle: 1_000 } }).budget.voteRateMaxPerCycle).toBe(1_000)
  })
  it('rejects mintRateMaxPerCycle above the 1000 ceiling', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintRateMaxPerCycle: 1_001 } })).toThrow()
  })
  it('rejects gas caps above the 10 ETH ceiling (all three)', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, voteGasEthMax: 11 } })).toThrow()
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintGasEthMax: 11 } })).toThrow()
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, claimGasEthMax: 11 } })).toThrow()
  })
  it('rejects stake.lockReppo above the 10M ceiling, accepts at the ceiling', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, stake: { ...valid.stake, lockReppo: 10_000_001 } })).toThrow()
    expect(StrategyConfigSchema.parse({ ...valid, stake: { ...valid.stake, lockReppo: 10_000_000 } }).stake.lockReppo).toBe(10_000_000)
  })
  it('rejects an Infinity cap (cannot unbound the wallet)', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintReppoMax: Infinity } })).toThrow()
  })
})

describe('StrategyConfig budget/stake ceilings (caps are the real security boundary)', () => {
  it('rejects mintReppoMax above the 1M ceiling, accepts at the ceiling', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintReppoMax: 1_000_001 } })).toThrow()
    expect(StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintReppoMax: 1_000_000 } }).budget.mintReppoMax).toBe(1_000_000)
  })
  it('rejects voteRateMaxPerCycle above the 1000 ceiling, accepts at the ceiling', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, voteRateMaxPerCycle: 1_001 } })).toThrow()
    expect(StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, voteRateMaxPerCycle: 1_000 } }).budget.voteRateMaxPerCycle).toBe(1_000)
  })
  it('rejects mintRateMaxPerCycle above the 1000 ceiling', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintRateMaxPerCycle: 1_001 } })).toThrow()
  })
  it('rejects gas caps above the 10 ETH ceiling (all three)', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, voteGasEthMax: 11 } })).toThrow()
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintGasEthMax: 11 } })).toThrow()
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, claimGasEthMax: 11 } })).toThrow()
  })
  it('rejects stake.lockReppo above the 10M ceiling, accepts at the ceiling', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, stake: { ...valid.stake, lockReppo: 10_000_001 } })).toThrow()
    expect(StrategyConfigSchema.parse({ ...valid, stake: { ...valid.stake, lockReppo: 10_000_000 } }).stake.lockReppo).toBe(10_000_000)
  })
  it('rejects an Infinity cap (cannot unbound the wallet)', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, budget: { ...valid.budget, mintReppoMax: Infinity } })).toThrow()
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

describe('StrategyConfig datanet model override', () => {
  it('accepts an explicit { provider, model } override on a datanet policy', () => {
    const cfg = StrategyConfigSchema.parse({
      ...valid,
      datanets: { '9': { vote: true, strictness: 'balanced', model: { provider: 'google', model: 'gemini-3-pro' } } },
    })
    const p = cfg.datanets['9'] as { model?: { provider: string; model: string } }
    expect(p.model).toEqual({ provider: 'google', model: 'gemini-3-pro' })
  })
  it('rejects an unknown provider in the model override', () => {
    const bad = { ...valid, datanets: { '9': { vote: true, strictness: 'balanced', model: { provider: 'mistral', model: 'm' } } } }
    expect(() => StrategyConfigSchema.parse(bad)).toThrow()
  })
  it('rejects an empty model string in the model override', () => {
    const bad = { ...valid, datanets: { '9': { vote: true, strictness: 'balanced', model: { provider: 'google', model: '' } } } }
    expect(() => StrategyConfigSchema.parse(bad)).toThrow()
  })
  it('parses a datanet with no model override (absent ⇒ node default)', () => {
    const cfg = StrategyConfigSchema.parse(valid)
    expect((cfg.datanets['9'] as { model?: unknown }).model).toBeUndefined()
  })
})

describe('StrategyConfig datanet voteShare', () => {
  it('defaults voteShare to 1 when absent', () => {
    expect(StrategyConfigSchema.parse(valid).datanets['9'].voteShare).toBe(1)
  })
  it('accepts an explicit positive voteShare', () => {
    const cfg = StrategyConfigSchema.parse({ ...valid, datanets: { '9': { vote: true, strictness: 'balanced', voteShare: 3 } } })
    expect(cfg.datanets['9'].voteShare).toBe(3)
  })
  it('rejects voteShare of 0', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, datanets: { '9': { vote: true, strictness: 'balanced', voteShare: 0 } } })).toThrow()
  })
  it('rejects a negative voteShare', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, datanets: { '9': { vote: true, strictness: 'balanced', voteShare: -2 } } })).toThrow()
  })
  it('rejects a fractional voteShare (weights are whole numbers)', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, datanets: { '9': { vote: true, strictness: 'balanced', voteShare: 1.5 } } })).toThrow()
  })
  it('rejects a non-finite voteShare (Infinity)', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, datanets: { '9': { vote: true, strictness: 'balanced', voteShare: Infinity } } })).toThrow()
  })
})

describe('StrategyConfig defaultModel', () => {
  it('accepts an optional top-level defaultModel', () => {
    const cfg = StrategyConfigSchema.parse({
      ...valid,
      defaultModel: { provider: 'usepod', model: 'deepseek-v3.2' },
    })
    expect(cfg.defaultModel).toEqual({ provider: 'usepod', model: 'deepseek-v3.2' })
  })

  it('rejects a defaultModel with an unknown provider', () => {
    expect(() => StrategyConfigSchema.parse({
      ...valid,
      defaultModel: { provider: 'mistral-inc', model: 'x' },
    })).toThrow()
  })

  it('treats defaultModel as optional (absent is valid)', () => {
    const cfg = StrategyConfigSchema.parse({ ...valid })
    expect(cfg.defaultModel).toBeUndefined()
  })

  describe('paused (operator kill switch)', () => {
    it('defaults to false — every pre-existing config loads UNPAUSED', () => {
      expect(StrategyConfigSchema.parse(valid).paused).toBe(false)
    })

    it('round-trips true', () => {
      expect(StrategyConfigSchema.parse({ ...valid, paused: true }).paused).toBe(true)
    })

    it('rejects a non-boolean (a truthy string must not silently pause/unpause a node)', () => {
      expect(() => StrategyConfigSchema.parse({ ...valid, paused: 'yes' })).toThrow()
    })
  })
})
