// src/minter/score.test.ts
import { describe, it, expect } from 'vitest'
import { candidateScoreInput } from './score.js'
import type { CandidatePod } from '../adapter/types.js'

const cand = (over: Partial<CandidatePod> = {}): CandidatePod => ({
  canonicalKey: 'k1', podName: 'HL perps, 0x06..164b: 3 trades',
  podDescription: 'summary line', dataset: { trades: [{ market: 'BTC', pnl: 100, win: true, tx_hashes: ['0xabc'] }] },
  ...over,
})

describe('candidateScoreInput', () => {
  it('passes the pod name through unchanged', () => {
    expect(candidateScoreInput(cand()).name).toBe('HL perps, 0x06..164b: 3 trades')
  })

  it('includes the actual dataset content in the scored text, not just the summary', () => {
    const { description } = candidateScoreInput(cand())
    expect(description).toContain('summary line')      // original description retained
    expect(description).toContain('BTC')               // dataset detail now visible to the scorer
    expect(description).toContain('0xabc')             // verification (tx hash) now visible
  })

  it('caps the dataset sample so a huge dataset cannot blow the prompt', () => {
    const big = { trades: Array.from({ length: 5000 }, (_, i) => ({ market: 'X', pnl: i, tx: `0x${i}` })) }
    const { description } = candidateScoreInput(cand({ dataset: big }))
    expect(description.length).toBeLessThan(5000)
    expect(description).toContain('truncated')
  })

  it('falls back to the description when the dataset is not serializable (never throws)', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const { description } = candidateScoreInput(cand({ dataset: circular }))
    expect(description).toContain('summary line')      // graceful fallback, no throw
  })
})
