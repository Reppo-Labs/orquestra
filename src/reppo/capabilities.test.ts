import { describe, it, expect } from 'vitest'
import { supportsNonReppoGrants, NONREPPO_GRANT_MIN_VERSION } from './capabilities.js'

describe('supportsNonReppoGrants', () => {
  it('exports the min version the gate keys off', () => {
    expect(NONREPPO_GRANT_MIN_VERSION).toBe('0.8.5')
  })

  it('rejects a CLI just below the threshold', () => {
    expect(supportsNonReppoGrants('0.8.4')).toBe(false)
  })

  it('accepts exactly the threshold', () => {
    expect(supportsNonReppoGrants('0.8.5')).toBe(true)
  })

  it('accepts newer versions numerically (not lexicographically)', () => {
    expect(supportsNonReppoGrants('0.9.0')).toBe(true)
    expect(supportsNonReppoGrants('0.10.0')).toBe(true) // 0.10 > 0.8 lexically would fail
    expect(supportsNonReppoGrants('1.0.0')).toBe(true)
  })

  it('parses the version out of a noisy banner (date/build tokens, v-prefix)', () => {
    expect(supportsNonReppoGrants('reppo 2024.01 v0.8.5')).toBe(true)
    expect(supportsNonReppoGrants('@reppo/cli v0.8.5 (node 20.1.0)')).toBe(true)
    // too-old banner with a date token must still be rejected (year filtered, not picked)
    expect(supportsNonReppoGrants('reppo 2024.01.05 0.8.4')).toBe(false)
  })

  it('rejects an unparseable / empty banner (fail-closed)', () => {
    expect(supportsNonReppoGrants('')).toBe(false)
    expect(supportsNonReppoGrants('not a version')).toBe(false)
  })
})
