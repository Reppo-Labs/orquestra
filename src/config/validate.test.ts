import { describe, it, expect } from 'vitest'
import { validateConfigText } from './validate.js'

const good = {
  horizonDays: 30, cadenceHours: 6,
  stake: { lockReppo: 500, lockDurationDays: 30 },
  budget: { voteRateMaxPerCycle: 25, mintReppoMax: 100 },
  datanets: { '9': { vote: true, strictness: 'balanced' } },
}

describe('validateConfigText', () => {
  it('returns ok + the parsed config for a valid config', () => {
    const r = validateConfigText(JSON.stringify(good))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config.datanets['9'].vote).toBe(true)
      expect(r.config.notes).toBe('') // defaults applied
    }
  })

  it('returns a readable error for invalid JSON', () => {
    const r = validateConfigText('{ not json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/json/i)
  })

  it('returns a readable error for a schema violation', () => {
    const r = validateConfigText(JSON.stringify({ ...good, horizonDays: -1 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/horizonDays/)
  })

  it('rejects an unknown datanet policy field (strict policy)', () => {
    const r = validateConfigText(JSON.stringify({ ...good, datanets: { '9': { vote: true, bogus: 1 } } }))
    expect(r.ok).toBe(false)
  })
})
