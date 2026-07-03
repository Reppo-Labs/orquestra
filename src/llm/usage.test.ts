import { describe, it, expect, beforeEach } from 'vitest'
import { priceFor, recordLlmUsage, resetLlmUsage, snapshotLlmUsage } from './usage.js'

beforeEach(() => resetLlmUsage())

describe('priceFor', () => {
  it('matches known models by substring', () => {
    expect(priceFor('claude-sonnet-4-5')).toEqual([3, 15])
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual([1, 5])
    expect(priceFor('gpt-4o-mini')).toEqual([0.15, 0.6])
    expect(priceFor('gemini-3-flash-preview')).toEqual([0.3, 2.5])
  })
  it('longest key wins — gpt-4o-mini is not priced as gpt-4o', () => {
    expect(priceFor('gpt-4o-mini')).not.toEqual(priceFor('gpt-4o'))
  })
  it('returns null for unknown models', () => {
    expect(priceFor('some-local-llama')).toBeNull()
  })
})

describe('usage accumulator', () => {
  it('accumulates calls and tokens per model and prices them', () => {
    recordLlmUsage('claude-sonnet-4-5', 1_000_000, 100_000)
    recordLlmUsage('claude-sonnet-4-5', 500_000, 50_000)
    const s = snapshotLlmUsage()
    expect(s.calls).toBe(2)
    expect(s.inputTokens).toBe(1_500_000)
    expect(s.outputTokens).toBe(150_000)
    // 1.5M in * $3/M + 0.15M out * $15/M = 4.5 + 2.25 = 6.75
    expect(s.estCostUsd).toBeCloseTo(6.75)
    expect(s.unpricedCalls).toBe(0)
  })

  it('unknown models count tokens but contribute null cost + unpricedCalls', () => {
    recordLlmUsage('mystery-model', 10_000, 1_000)
    const s = snapshotLlmUsage()
    expect(s.calls).toBe(1)
    expect(s.estCostUsd).toBeNull() // NOTHING priceable → null, not 0
    expect(s.unpricedCalls).toBe(1)
    expect(s.byModel['mystery-model'].estCostUsd).toBeNull()
  })

  it('mixed known+unknown: cost covers only priced models, unpricedCalls flags the rest', () => {
    recordLlmUsage('claude-haiku-4-5', 1_000_000, 0) // $1
    recordLlmUsage('mystery-model', 999_999, 999_999)
    const s = snapshotLlmUsage()
    expect(s.estCostUsd).toBeCloseTo(1)
    expect(s.unpricedCalls).toBe(1)
  })

  it('NaN/missing token fields are treated as 0, never poisoning the sums', () => {
    recordLlmUsage('claude-haiku-4-5', NaN, 500_000)
    const s = snapshotLlmUsage()
    expect(s.inputTokens).toBe(0)
    expect(s.outputTokens).toBe(500_000)
    expect(s.estCostUsd).toBeCloseTo(2.5) // 0.5M out * $5/M
  })

  it('reset zeroes the window (per-cycle semantics)', () => {
    recordLlmUsage('claude-haiku-4-5', 100, 100)
    resetLlmUsage()
    const s = snapshotLlmUsage()
    expect(s.calls).toBe(0)
    expect(s.estCostUsd).toBeNull()
  })
})
