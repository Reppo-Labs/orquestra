import { describe, it, expect } from 'vitest'
import { budgetBar } from './BudgetBurn'
import { onboardingStep } from './Onboarding'

// Pure-logic smoke tests for the two components. Full render+submit tests need jsdom +
// @testing-library/react, which are NOT installed (web/package.json) — see the report.

describe('budgetBar (BudgetBurn burn-bar math)', () => {
  it('computes the spent percentage, rounded', () => {
    expect(budgetBar(25, 100).pct).toBe(25)
    expect(budgetBar(1, 3).pct).toBe(33) // 33.33 → 33
    expect(budgetBar(2, 3).pct).toBe(67) // 66.66 → 67
  })

  it('clamps overspend to 100% (bar never overflows its track)', () => {
    expect(budgetBar(150, 100).pct).toBe(100)
  })

  it('flags "hot" at or above 80% spent, not below', () => {
    expect(budgetBar(79, 100).hot).toBe(false)
    expect(budgetBar(80, 100).hot).toBe(true)
    expect(budgetBar(100, 100).hot).toBe(true)
  })

  it('renders an ∞ cap label and 0% (no div-by-zero) when the max is missing', () => {
    expect(budgetBar(50, null)).toEqual({ pct: 0, maxLabel: '∞', hot: false })
    expect(budgetBar(50, undefined)).toEqual({ pct: 0, maxLabel: '∞', hot: false })
  })

  it('treats a zero cap as 0% (avoids Infinity) while still showing the numeric label', () => {
    const bar = budgetBar(50, 0)
    expect(bar.pct).toBe(0)
    expect(bar.maxLabel).toBe('0')
  })

  it('formats the numeric cap label via fmt', () => {
    expect(budgetBar(0, 1000).maxLabel).toBe('1,000')
  })
})

describe('onboardingStep (Connect → Interview → Review → Start)', () => {
  it('is Connect(1) before the interview starts', () => {
    expect(onboardingStep(false, null, '')).toBe(1)
  })

  it('is Interview(2) once started but not yet finalized', () => {
    expect(onboardingStep(true, null, '')).toBe(2)
  })

  it('is Review(3) once a strategy is finalized but not yet saved', () => {
    expect(onboardingStep(true, { nodeName: 'n' }, '')).toBe(3)
    expect(onboardingStep(true, { nodeName: 'n' }, 'saving…')).toBe(3)
  })

  it('advances to Start(4) only once the confirm POST reports "saved…"', () => {
    expect(onboardingStep(true, { nodeName: 'n' }, 'saved — the node starts its first cycle shortly')).toBe(4)
  })

  it('an error confirm message keeps it on Review, not Start', () => {
    expect(onboardingStep(true, { nodeName: 'n' }, 'error: boom')).toBe(3)
  })
})
