import { describe, it, expect } from 'vitest'
import { parseVotingPower } from './queryVotingPower.js'

describe('parseVotingPower', () => {
  it('extracts power + lockup count from {raw,formatted} shape', () => {
    expect(parseVotingPower({ votingPower: { formatted: '500.0' }, lockupCount: 2 }))
      .toEqual({ power: 500, lockupCount: 2 })
  })
  it('handles plain-number and missing fields', () => {
    expect(parseVotingPower({ votingPower: 250 })).toEqual({ power: 250, lockupCount: 0 })
    expect(parseVotingPower(null)).toEqual({ power: 0, lockupCount: 0 })
  })
})
