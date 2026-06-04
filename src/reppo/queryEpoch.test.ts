// src/reppo/queryEpoch.test.ts
import { describe, it, expect } from 'vitest'
import { parseEpoch } from './queryEpoch.js'

describe('parseEpoch', () => {
  it('extracts epoch fields', () => {
    expect(parseEpoch({ network: 'mainnet', epoch: 97, epochStart: 1780493161, epochDurationSeconds: 172800, secondsRemaining: 72636 }))
      .toEqual({ epoch: 97, epochStart: 1780493161, epochDurationSeconds: 172800, secondsRemaining: 72636 })
  })
  it('defaults missing/garbage to 0', () => {
    expect(parseEpoch(null)).toEqual({ epoch: 0, epochStart: 0, epochDurationSeconds: 0, secondsRemaining: 0 })
    expect(parseEpoch({ epoch: 'x' })).toEqual({ epoch: 0, epochStart: 0, epochDurationSeconds: 0, secondsRemaining: 0 })
  })
})
