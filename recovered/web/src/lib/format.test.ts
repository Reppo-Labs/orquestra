import { describe, it, expect } from 'vitest'
import { fmt, fmtCount, fmtEth, fmtPct, fmtPerVote, fmtReppo, fmtUsd, netLabel, sign } from './format'

// The operator-facing contract: no raw floats, no scientific notation, always a unit.

describe('fmt', () => {
  it('rounds a long float to a legible precision instead of dumping every digit', () => {
    expect(fmt(821.91027196)).toBe('821.9')
  })
  it('drops decimals entirely on thousands and separates them', () => {
    expect(fmt(1906.4812)).toBe('1,906')
    expect(fmt(10290.0004)).toBe('10,290')
  })
  it('keeps two decimals in the 1–100 range', () => {
    expect(fmt(12.3456)).toBe('12.35')
  })
  it('never renders scientific notation for small magnitudes', () => {
    for (const n of [1.36e-3, 6.97e-4, 9.84e2, 1.2e-5]) {
      expect(fmt(n)).not.toMatch(/e/i)
    }
    expect(fmt(1.36e-3)).toBe('0.00136')
    expect(fmt(6.97e-4)).toBe('0.000697')
    expect(fmt(9.84e2)).toBe('984')
  })
  it('bounds a value too tiny to print rather than rounding it to a false 0', () => {
    expect(fmt(1e-9)).toBe('<0.000001')
    expect(fmt(-1e-9)).toBe('>-0.000001')
  })
  it('renders exact zero as 0 and nullish as an em dash', () => {
    expect(fmt(0)).toBe('0')
    expect(fmt(null)).toBe('—')
    expect(fmt(undefined)).toBe('—')
    expect(fmt(NaN)).toBe('—')
  })
  it('keeps integers integral (the budget bar depends on this)', () => {
    expect(fmt(25)).toBe('25')
    expect(fmt(1000)).toBe('1,000')
  })
})

describe('fmtCount', () => {
  it('renders whole units with separators, never a fraction', () => {
    expect(fmtCount(21033942)).toBe('21,033,942')
    expect(fmtCount(3.6)).toBe('4')
  })
  it('degrades nullish to an em dash', () => {
    expect(fmtCount(undefined)).toBe('—')
  })
})

describe('unit-carrying helpers', () => {
  it('always attaches the token symbol', () => {
    expect(fmtReppo(1906.4812)).toBe('1,906 REPPO')
    expect(fmtEth(0.0123456)).toBe('0.0123 ETH')
  })
  it('formats USD with a floor so a real cost never reads as $0.00', () => {
    expect(fmtUsd(0.004)).toBe('<$0.01')
    expect(fmtUsd(1.239)).toBe('$1.24')
    expect(fmtUsd(null)).toBe('—')
  })
  it('turns a 0–1 rate into a percentage, and unknown into an em dash (not 0%)', () => {
    expect(fmtPct(1)).toBe('100%')
    expect(fmtPct(0.8)).toBe('80%')
    expect(fmtPct(0.8, 1)).toBe('80.0%')
    expect(fmtPct(null)).toBe('—')
  })
})

describe('fmtPerVote', () => {
  it('renders a readable amount with a unit instead of an exponent', () => {
    expect(fmtPerVote(9.84e2)).toBe('984 REPPO/vote')
    expect(fmtPerVote(1.36e-3)).toBe('0.00136 REPPO/vote')
  })
  it('falls back to a qualitative bound when the yield is vanishingly small', () => {
    expect(fmtPerVote(6.97e-4)).toBe('<0.001 REPPO/vote')
    expect(fmtPerVote(1e-9)).toBe('<0.001 REPPO/vote')
  })
  it('states an explicit zero and an unknown', () => {
    expect(fmtPerVote(0)).toBe('0 REPPO/vote')
    expect(fmtPerVote(null)).toBe('—')
  })
  it('accepts a non-REPPO unit', () => {
    expect(fmtPerVote(2.5, 'LBM')).toBe('2.5 LBM/vote')
  })
})

describe('sign / netLabel', () => {
  it('maps profit and loss to the money colours only', () => {
    expect(sign(1)).toBe('pos')
    expect(sign(-1)).toBe('neg')
    expect(sign(0)).toBe('')
  })
  it('labels a datanet by id until names load', () => {
    expect(netLabel('9', {})).toBe('9')
    expect(netLabel('9', { '9': 'Hyperliquid' })).toBe('9 · Hyperliquid')
  })
})
