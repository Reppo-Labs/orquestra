// src/onboarding/schema.test.ts
import { describe, it, expect } from 'vitest'
import { OnboardingAnswersSchema, validateAnswers } from './schema.js'

const good = {
  datanets: [{ id: '9', vote: true, mint: true, strictness: 'conservative', adapter: 'hyperliquid' }],
  lockReppo: 500, lockDurationDays: 30, voteGasEthMax: 0.02, voteRateMaxPerCycle: 25,
  mintReppoMax: 100, mintGasEthMax: 0.05, horizonDays: 30, cadenceHours: 6, notes: 'x',
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
