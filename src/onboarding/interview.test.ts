// src/onboarding/interview.test.ts
import { describe, it, expect } from 'vitest'
import { runOnboarding } from './interview.js'
import type { Prompter } from './types.js'

/** Scripted prompter: returns queued answers in order; blank falls back to the default. */
function scripted(answers: string[]): Prompter {
  let i = 0
  return {
    ask: async (_q: string, def?: string) => {
      const a = answers[i++]
      return a === undefined || a === '' ? (def ?? '') : a
    },
    info: () => {},
  }
}

describe('runOnboarding', () => {
  it('collects answers into an OnboardingAnswers via the prompter', async () => {
    const p = scripted([
      '9',            // datanet ids (comma-separated)
      'y', 'y', 'conservative', 'hyperliquid', // datanet 9: vote? mint? strictness adapter
      '500', '30',    // lockReppo, lockDurationDays
      '0.02', '25', '100', '0.05', // voteGasEthMax, voteRateMaxPerCycle, mintReppoMax, mintGasEthMax
      '30', '6',      // horizonDays, cadenceHours
      'be picky',     // notes
    ])
    const ans = await runOnboarding(p)
    expect(ans.datanets).toHaveLength(1)
    expect(ans.datanets[0]).toEqual({ id: '9', vote: true, mint: true, strictness: 'conservative', adapter: 'hyperliquid' })
    expect(ans.lockReppo).toBe(500)
    expect(ans.cadenceHours).toBe(6)
    expect(ans.notes).toBe('be picky')
  })

  it('uses defaults when answers are blank, and parses y/n loosely', async () => {
    const p = scripted([
      '9',
      '', 'n', '', '',     // vote (default y), mint n, strictness default, adapter default (none)
      '', '', '', '', '', '', '', '', '', // numeric fields + notes all default/blank
    ])
    const ans = await runOnboarding(p)
    expect(ans.datanets[0].vote).toBe(true)   // blank → default yes
    expect(ans.datanets[0].mint).toBe(false)
    expect(ans.datanets[0].strictness).toBe('balanced') // default
    expect(ans.datanets[0].adapter).toBeUndefined()
    expect(ans.lockReppo).toBeGreaterThanOrEqual(0)
  })
})
