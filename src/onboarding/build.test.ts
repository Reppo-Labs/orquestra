// src/onboarding/build.test.ts
import { describe, it, expect } from 'vitest'
import { buildStrategyConfig } from './build.js'
import type { OnboardingAnswers } from './types.js'

const answers = (): OnboardingAnswers => ({
  datanets: [
    { id: '9', vote: true, mint: true, strictness: 'conservative', adapter: 'hyperliquid' },
    { id: '2', vote: true, mint: false, strictness: 'balanced' },
  ],
  lockReppo: 500, lockDurationDays: 30,
  voteGasEthMax: 0.02, voteRateMaxPerCycle: 25, mintReppoMax: 100, mintGasEthMax: 0.05,
  horizonDays: 30, cadenceHours: 6, notes: 'be picky on TradingGym',
})

describe('buildStrategyConfig', () => {
  it('assembles a valid StrategyConfig from answers', () => {
    const cfg = buildStrategyConfig(answers())
    expect(cfg.datanets['9'].mint).toBe(true)
    expect(cfg.datanets['9'].adapter).toBe('hyperliquid')
    expect(cfg.datanets['2'].mint).toBe(false)
    expect(cfg.stake.lockReppo).toBe(500)
    expect(cfg.budget.mintReppoMax).toBe(100)
    expect(cfg.notes).toBe('be picky on TradingGym')
    expect(cfg.datanets['*'].vote).toBe(false) // wildcard default from schema
  })

  it('throws on an invalid answer (e.g. negative horizon) via schema validation', () => {
    expect(() => buildStrategyConfig({ ...answers(), horizonDays: -1 })).toThrow()
  })
})

describe('buildStrategyConfig adapterParams', () => {
  it('writes adapterParams onto the datanet policy when present', () => {
    const a = answers()
    a.datanets[0].adapter = 'gdelt'
    a.datanets[0].adapterParams = { focus: 'Taiwan', angle: 'risk', topN: 4, minImportance: 7 }
    const cfg = buildStrategyConfig(a)
    const p = cfg.datanets[a.datanets[0].id] as { adapterParams?: { focus?: string } }
    expect(p.adapterParams?.focus).toBe('Taiwan')
  })
  it('omits adapterParams when not provided', () => {
    const a = answers()
    const cfg = buildStrategyConfig(a)
    const p = cfg.datanets[a.datanets[1].id] as { adapterParams?: unknown }
    expect(p.adapterParams).toBeUndefined()
  })
})
