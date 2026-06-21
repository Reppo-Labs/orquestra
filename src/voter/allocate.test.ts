import { describe, it, expect } from 'vitest'
import { allocateVoteSlots } from './allocate.js'

const m = (o: Record<string, number>) => new Map(Object.entries(o))
const obj = (x: Map<string, number>) => Object.fromEntries(x)
const sum = (x: Map<string, number>) => [...x.values()].reduce((a, b) => a + b, 0)

describe('allocateVoteSlots', () => {
  it('splits evenly across equal weights', () => {
    expect(obj(allocateVoteSlots(m({ a: 1, b: 1 }), 10))).toEqual({ a: 5, b: 5 })
  })

  it('splits in proportion to weights (3:1)', () => {
    expect(obj(allocateVoteSlots(m({ a: 3, b: 1 }), 8))).toEqual({ a: 6, b: 2 })
  })

  it('distributes the largest-remainder slots, breaking ties by id ascending', () => {
    // ideal 3.33 each → floors 3,3,3 (sum 9), 1 leftover → all remainders equal → id 'a' wins
    expect(obj(allocateVoteSlots(m({ a: 1, b: 1, c: 1 }), 10))).toEqual({ a: 4, b: 3, c: 3 })
  })

  it('weight magnitude is irrelevant — only ratios matter', () => {
    expect(obj(allocateVoteSlots(m({ a: 30, b: 10 }), 8))).toEqual({ a: 6, b: 2 })
  })

  it('always sums to total', () => {
    const out = allocateVoteSlots(m({ a: 2, b: 5, c: 1, d: 7 }), 30)
    expect(sum(out)).toBe(30)
  })

  it('gives the whole total to a single datanet', () => {
    expect(obj(allocateVoteSlots(m({ a: 4 }), 30))).toEqual({ a: 30 })
  })

  it('returns all zeros when total is 0', () => {
    expect(obj(allocateVoteSlots(m({ a: 1, b: 3 }), 0))).toEqual({ a: 0, b: 0 })
  })

  it('returns an empty map for empty weights', () => {
    expect(obj(allocateVoteSlots(m({}), 30))).toEqual({})
  })

  it('handles a dominant weight without starving sum invariant', () => {
    const out = allocateVoteSlots(m({ big: 100, small: 1 }), 30)
    expect(sum(out)).toBe(30)
    expect(out.get('big')!).toBeGreaterThan(out.get('small')!)
    expect(out.get('small')!).toBeGreaterThanOrEqual(0)
  })
})
