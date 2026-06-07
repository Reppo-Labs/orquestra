import { describe, it, expect } from 'vitest'
import { fillsWindow } from './window.js'

// epochStart/epochDurationSeconds are UNIX SECONDS (from `reppo query epoch`).
const epoch = { epochStart: 1_780_000_000, epochDurationSeconds: 172_800 }
const NOW_MS = 1_780_100_000_000 // some time during/after the epoch, in ms

describe('fillsWindow', () => {
  it('starts openLookbackDays before the epoch start (ms) so opens are captured', () => {
    const w = fillsWindow(epoch, 30, NOW_MS)
    expect(w.startTime).toBe((1_780_000_000 - 30 * 86_400) * 1000)
  })

  it('ends at now (ms) when now is after epoch start', () => {
    expect(fillsWindow(epoch, 30, NOW_MS).endTime).toBe(NOW_MS)
  })

  it('never returns a negative startTime', () => {
    expect(fillsWindow({ epochStart: 10, epochDurationSeconds: 100 }, 365, NOW_MS).startTime).toBe(0)
  })

  it('endTime is never before the epoch start (clock skew guard)', () => {
    const earlyNow = (1_780_000_000 - 1000) * 1000
    expect(fillsWindow(epoch, 30, earlyNow).endTime).toBe(1_780_000_000 * 1000)
  })

  it('caps endTime at the epoch end when now is past it', () => {
    const w = fillsWindow(epoch, 30, (1_780_000_000 + 999_999) * 1000) // now far past epoch end
    expect(w.endTime).toBe((1_780_000_000 + 172_800) * 1000)
  })
})
