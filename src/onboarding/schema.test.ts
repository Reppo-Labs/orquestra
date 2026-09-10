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
  it('accepts a no-lock answer set (robinhood: lockReppo 0 + lockDurationDays 0)', () => {
    const res = validateAnswers({ ...good, lockReppo: 0, lockDurationDays: 0 })
    expect(res.ok).toBe(true)
  })
  it('still rejects a zero duration when actually locking', () => {
    const res = validateAnswers({ ...good, lockReppo: 500, lockDurationDays: 0 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/lockDurationDays/)
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

describe('OnboardingAnswersSchema + validateAnswers defaultModel', () => {
  const base = {
    datanets: [{ id: '2', vote: true, mint: false, strictness: 'balanced' as const }],
    lockReppo: 500, lockDurationDays: 30, voteRateMaxPerCycle: 25,
    mintReppoMax: 100, horizonDays: 30, cadenceHours: 6, notes: 'n',
  }

  it('accepts and preserves a defaultModel through validateAnswers', () => {
    const r = validateAnswers({ ...base, defaultModel: { provider: 'usepod', model: 'deepseek-v3.2' } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.answers.defaultModel).toEqual({ provider: 'usepod', model: 'deepseek-v3.2' })
  })

  it('accepts a JSON-STRINGIFIED defaultModel (LLM tool calls stringify nested objects)', () => {
    const r = validateAnswers({ ...base, defaultModel: JSON.stringify({ provider: 'usepod', model: 'qwen-3.5' }) })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.answers.defaultModel?.model).toBe('qwen-3.5')
  })

  it('rejects an unknown provider', () => {
    expect(validateAnswers({ ...base, defaultModel: { provider: 'mistral-inc', model: 'x' } }).ok).toBe(false)
  })

  it('rejects a blank model id (config schema requires min(1))', () => {
    expect(validateAnswers({ ...base, defaultModel: { provider: 'usepod', model: '  ' } }).ok).toBe(false)
  })

  it('treats defaultModel as optional', () => {
    const r = validateAnswers(base)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.answers.defaultModel).toBeUndefined()
  })

  it('REFUSES a provider this node holds no key for (never persist an unresolvable model)', () => {
    const r = validateAnswers({ ...base, defaultModel: { provider: 'openai', model: 'gpt-5.2' } }, ['usepod', 'google'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('has no API key on this node')
  })

  it('accepts a provider that IS keyed on this node', () => {
    expect(validateAnswers({ ...base, defaultModel: { provider: 'google', model: 'gemini-3-flash-preview' } }, ['usepod', 'google']).ok).toBe(true)
  })

  it('FAILS OPEN when the provider list is unknown/empty — unread availability is not "unavailable"', () => {
    expect(validateAnswers({ ...base, defaultModel: { provider: 'openai', model: 'gpt-5.2' } }, []).ok).toBe(true)
    expect(validateAnswers({ ...base, defaultModel: { provider: 'openai', model: 'gpt-5.2' } }).ok).toBe(true)
  })

  it('does not gate answers that carry no defaultModel at all', () => {
    expect(validateAnswers(base, ['usepod']).ok).toBe(true)
  })
})
