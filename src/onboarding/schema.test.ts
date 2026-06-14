// src/onboarding/schema.test.ts
import { describe, it, expect } from 'vitest'
import { OnboardingAnswersSchema, validateAnswers } from './schema.js'

const good = {
  datanets: [{ id: '9', vote: true, mint: true, strictness: 'conservative', adapter: 'hyperliquid' }],
  lockReppo: 500, lockDurationDays: 30, voteRateMaxPerCycle: 25,
  mintReppoMax: 100, horizonDays: 30, cadenceHours: 6, notes: 'x',
}

describe('OnboardingAnswersSchema / validateAnswers', () => {
  it('parses a good answer set', () => {
    expect(OnboardingAnswersSchema.parse(good).datanets[0].id).toBe('9')
  })
  it('validateAnswers returns ok:true for valid, ok:false+error for invalid', () => {
    expect(validateAnswers(good).ok).toBe(true)
    const bad = validateAnswers({ ...good, horizonDays: -1 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/horizon|number|positive|greater/i)
  })
})

describe('OnboardingAnswersSchema adapterParams', () => {
  const base = {
    datanets: [{ id: '2', vote: true, mint: true, strictness: 'balanced' as const, adapter: 'gdelt',
      adapterParams: { focus: 'Middle East', angle: 'contrarian', topN: 4, minImportance: 7 } }],
    lockReppo: 500, lockDurationDays: 30, voteRateMaxPerCycle: 25,
    mintReppoMax: 100, horizonDays: 30, cadenceHours: 6, notes: 'n',
  }
  it('accepts a datanet choice with adapterParams', () => {
    const parsed = OnboardingAnswersSchema.parse(base)
    expect(parsed.datanets[0].adapterParams?.focus).toBe('Middle East')
  })
  it('accepts a datanet choice WITHOUT adapterParams (optional)', () => {
    const { adapterParams, ...d } = base.datanets[0]
    expect(OnboardingAnswersSchema.parse({ ...base, datanets: [d] }).datanets[0].adapterParams).toBeUndefined()
  })
})
