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
  voteRateMaxPerCycle: 25, mintReppoMax: 100,   horizonDays: 30, cadenceHours: 6, notes: 'be picky on TradingGym',
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

  it('maps nodeName into the config (trimmed); omits it when absent or blank', () => {
    expect(buildStrategyConfig({ ...answers(), nodeName: '  My Node  ' }).nodeName).toBe('My Node')
    expect(buildStrategyConfig(answers()).nodeName).toBeUndefined()
    expect(buildStrategyConfig({ ...answers(), nodeName: '   ' }).nodeName).toBeUndefined()
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

describe('buildStrategyConfig defaultModel', () => {
  // Operator bug: a model chosen during onboarding never reached the persisted config,
  // so the dashboard showed a selection the node did not use.
  it('maps defaultModel into the config', () => {
    const cfg = buildStrategyConfig({ ...answers(), defaultModel: { provider: 'usepod', model: 'deepseek-v3.2' } })
    expect(cfg.defaultModel).toEqual({ provider: 'usepod', model: 'deepseek-v3.2' })
  })

  it('omits defaultModel when the operator did not choose one (env default keeps winning)', () => {
    expect(buildStrategyConfig(answers()).defaultModel).toBeUndefined()
  })
})

describe('buildStrategyConfig mintFeeRatioMax', () => {
  // The fee gate has no safe default — a threshold set too low silently stops minting.
  // So onboarding carries the operator's opt-in through verbatim, and leaves the key
  // ABSENT when they never opted in (absent = gate off, which is the safety property).
  it('maps mintFeeRatioMax into budget when the operator chose one', () => {
    const cfg = buildStrategyConfig({ ...answers(), mintFeeRatioMax: 0.035 })
    expect(cfg.budget.mintFeeRatioMax).toBe(0.035)
  })

  it('omits mintFeeRatioMax when the operator declined (gate stays off)', () => {
    const cfg = buildStrategyConfig(answers())
    expect(cfg.budget.mintFeeRatioMax).toBeUndefined()
    expect('mintFeeRatioMax' in cfg.budget).toBe(false)
  })
})
