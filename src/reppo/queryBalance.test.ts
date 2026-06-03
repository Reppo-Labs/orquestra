// src/reppo/queryBalance.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseBalance, type WalletBalance } from './queryBalance.js'

const fixtureRaw = JSON.parse(
  readFileSync(resolve(__dirname, '../../test/fixtures/balance.json'), 'utf8'),
)

describe('parseBalance', () => {
  it('parses the fixture into the correct numbers', () => {
    const b: WalletBalance = parseBalance(fixtureRaw)
    expect(b.reppo).toBe(1234.5)
    expect(b.veReppo).toBe(500)
    expect(b.eth).toBe(0.05)
    expect(b.usdc).toBe(10)
  })

  it('returns all-zero on empty input', () => {
    const b = parseBalance({})
    expect(b).toEqual({ eth: 0, reppo: 0, veReppo: 0, usdc: 0 })
  })

  it('returns all-zero on malformed input (null/undefined/array)', () => {
    expect(parseBalance(null)).toEqual({ eth: 0, reppo: 0, veReppo: 0, usdc: 0 })
    expect(parseBalance(undefined)).toEqual({ eth: 0, reppo: 0, veReppo: 0, usdc: 0 })
    expect(parseBalance([])).toEqual({ eth: 0, reppo: 0, veReppo: 0, usdc: 0 })
  })

  it('handles formatted as a number (not a string)', () => {
    const b = parseBalance({
      balances: {
        eth: { formatted: 1.5 },
        reppo: { formatted: 999 },
        veReppo: { formatted: 0 },
        usdc: { formatted: 50 },
      },
    })
    expect(b.eth).toBe(1.5)
    expect(b.reppo).toBe(999)
    expect(b.veReppo).toBe(0)
    expect(b.usdc).toBe(50)
  })

  it('defaults missing token fields to 0', () => {
    const b = parseBalance({ balances: { reppo: { formatted: '42' } } })
    expect(b.reppo).toBe(42)
    expect(b.eth).toBe(0)
    expect(b.veReppo).toBe(0)
    expect(b.usdc).toBe(0)
  })

  it('defaults non-finite formatted values to 0', () => {
    const b = parseBalance({
      balances: {
        eth: { formatted: 'NaN' },
        reppo: { formatted: 'Infinity' },
        veReppo: { formatted: null },
        usdc: { formatted: '' },
      },
    })
    expect(b).toEqual({ eth: 0, reppo: 0, veReppo: 0, usdc: 0 })
  })
})
