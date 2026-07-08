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

  it('runNow triggers an off-schedule tick between scheduled fires', async () => {
    const tick = vi.fn(async () => {})
    const h = startScheduler(6, tick)
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1) // immediate run
    const r = h.runNow()
    expect(r.started).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(2) // off-schedule run
    h.stop()
  })

  it('runNow is a no-op while a cycle is already running (no double-run)', async () => {
    const tick = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5 * 3600_000)) })
    const h = startScheduler(6, tick)
    await vi.advanceTimersByTimeAsync(0) // immediate run in-flight (busy)
    const r = h.runNow()
    expect(r.started).toBe(false)
    expect(r.reason).toMatch(/already running/)
    expect(tick).toHaveBeenCalledTimes(1)
    h.stop()
    await vi.advanceTimersByTimeAsync(6 * 3600_000)
  })

  it('runNow refuses once stopped', async () => {
    const tick = vi.fn(async () => {})
    const h = startScheduler(6, tick)
    await vi.advanceTimersByTimeAsync(0)
    h.stop()
    const r = h.runNow()
    expect(r.started).toBe(false)
    expect(r.reason).toMatch(/stopped/)
  })
})
