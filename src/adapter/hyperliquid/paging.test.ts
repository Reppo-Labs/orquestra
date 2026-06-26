import { describe, it, expect } from 'vitest'
import { fetchFillsPaged } from './index.js'

const win = { startTime: 0, endTime: 1_000_000 }
const fill = (time: number, hash: string) => ({ time, hash, coin: 'BTC' })
const noDelay = { interPageDelayMs: 0 }

describe('fetchFillsPaged', () => {
  it('returns a single short page as-is', async () => {
    const page = [fill(1, '0x1'), fill(2, '0x2')]
    const out = await fetchFillsPaged(async () => page, win, { pageSize: 2000, ...noDelay })
    expect(out).toHaveLength(2)
  })

  it('accumulates across multiple full pages until a short page', async () => {
    const pages = [
      Array.from({ length: 3 }, (_, i) => fill(10 + i, `a${i}`)),
      Array.from({ length: 3 }, (_, i) => fill(20 + i, `b${i}`)),
      [fill(30, 'c0')], // short page → stop
    ]
    let p = 0
    const out = await fetchFillsPaged(async () => pages[p++] ?? [], win, { pageSize: 3, ...noDelay })
    expect(out).toHaveLength(7)
  })

  it('dedups overlap when advancing the cursor to the last timestamp', async () => {
    // Page 1 ends at ts=30; page 2 re-includes the ts=30 fill (same hash) plus a new one.
    const pages = [
      [fill(10, 'x1'), fill(20, 'x2'), fill(30, 'x3')], // full page (size 3)
      [fill(30, 'x3'), fill(40, 'x4')],                 // short page; x3 is a dup
    ]
    let p = 0
    const out = await fetchFillsPaged(async () => pages[p++] ?? [], win, { pageSize: 3, ...noDelay })
    expect(out).toHaveLength(4)            // x1,x2,x3,x4 — x3 not double-counted
  })

  it('advances correctly when a page is returned newest-first (descending) — cursor uses max time, not last element', async () => {
    // Page 1 descending: [30,20,10]. Last element is the EARLIEST (10); using it as the
    // cursor would stall and drop page 2. Max (30) advances correctly.
    const pages = [
      [fill(30, 'd2'), fill(20, 'd1'), fill(10, 'd0')], // full page, descending
      [fill(40, 'e0')],                                  // short page → stop
    ]
    let p = 0
    const out = await fetchFillsPaged(async () => pages[p++] ?? [], win, { pageSize: 3, ...noDelay })
    expect(out).toHaveLength(4) // all of page 1 + page 2, none truncated
  })

  it('stops (no infinite loop) when a full page is stuck at one timestamp with all-dup hashes', async () => {
    const stuck = Array.from({ length: 3 }, (_, i) => fill(50, `s${i}`)) // all same ts, full page
    let calls = 0
    const out = await fetchFillsPaged(async () => { calls++; return stuck }, win, { pageSize: 3, maxPages: 10, ...noDelay })
    expect(calls).toBeLessThanOrEqual(2)   // first page adds 3, second adds 0 → stop
    expect(out).toHaveLength(3)
  })
})
