// src/runtime/scheduler.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startScheduler } from './scheduler.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('startScheduler', () => {
  it('runs the tick immediately, then every cadence interval', async () => {
    const tick = vi.fn(async () => {})
    const h = startScheduler(6, tick)
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6 * 3600_000)
    expect(tick).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(6 * 3600_000)
    expect(tick).toHaveBeenCalledTimes(3)
    h.stop()
    await vi.advanceTimersByTimeAsync(12 * 3600_000)
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('does not overlap ticks if one is still running (skips while busy)', async () => {
    let running = 0; let maxConcurrent = 0
    const tick = vi.fn(async () => {
      running++; maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((r) => setTimeout(r, 10 * 3600_000))
      running--
    })
    const h = startScheduler(6, tick)
    await vi.advanceTimersByTimeAsync(6 * 3600_000)
    expect(maxConcurrent).toBe(1)
    h.stop()
    await vi.advanceTimersByTimeAsync(20 * 3600_000)
  })
})
