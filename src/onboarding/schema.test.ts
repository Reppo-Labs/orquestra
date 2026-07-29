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

describe('OnboardingAnswersSchema LLM stringification tolerance', () => {
  it('accepts datanets as a JSON STRING (observed live: models stringify nested arrays in tool calls)', () => {
    const stringified = { ...good, datanets: JSON.stringify(good.datanets) }
    const parsed = OnboardingAnswersSchema.parse(stringified)
    expect(parsed.datanets[0].id).toBe('9')
    expect(validateAnswers(stringified).ok).toBe(true)
  })
  it('an unparseable datanets string still fails with the array error', () => {
    expect(OnboardingAnswersSchema.safeParse({ ...good, datanets: 'not json' }).success).toBe(false)
  })
  it('preserves sherwood adapterParams keys (brief/minSelfScore) instead of stripping them', () => {
    const answers = {
      ...good,
      datanets: [{
        id: '3', vote: true, mint: true, strictness: 'balanced',
        adapter: 'sherwood',
        adapterParams: { focus: 'WOOD CL LP', brief: 'tight reranges', topN: 1, minSelfScore: 7 },
      }],
    }
    const parsed = OnboardingAnswersSchema.parse(answers)
    expect(parsed.datanets[0].adapterParams).toMatchObject({ brief: 'tight reranges', minSelfScore: 7 })
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
