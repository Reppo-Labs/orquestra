import { describe, it, expect } from 'vitest'
import { clampPodName, POD_NAME_MAX } from './podName.js'

describe('clampPodName', () => {
  it('passes short names through unchanged', () => {
    expect(clampPodName('HL perps, 0x9984..95ba: 9 trades')).toBe('HL perps, 0x9984..95ba: 9 trades')
  })

  it('clamps the real 144-char live failure to ≤50 at a word boundary', () => {
    const long = "The US has added major Chinese firms including BYD and NIO to a 'Chinese military companies' blacklist, prompting formal objection from Beijing."
    const out = clampPodName(long)
    expect(out.length).toBeLessThanOrEqual(POD_NAME_MAX)
    expect(out).toBe('The US has added major Chinese firms including')
  })

  it('hard-cuts a name with no usable word boundary', () => {
    const out = clampPodName('x'.repeat(120))
    expect(out).toBe('x'.repeat(50))
  })

  it('normalizes whitespace before measuring', () => {
    expect(clampPodName('  a   b  ')).toBe('a b')
  })

  it('strips leading dashes so a hostile name cannot be parsed as a CLI flag', () => {
    expect(clampPodName('--dataset /etc/passwd')).toBe('dataset /etc/passwd')
    expect(clampPodName('-rf everything')).toBe('rf everything')
    expect(clampPodName('US-China tensions rise')).toBe('US-China tensions rise') // interior dashes fine
  })

  it('strips to a fixpoint — a dash-space-flag prefix cannot survive (review finding)', () => {
    expect(clampPodName('- --dataset /etc/passwd')).toBe('dataset /etc/passwd')
    expect(clampPodName('-- - -x payload')).toBe('x payload')
    expect(clampPodName('- --help')).toBe('help')
  })

  it('never emits an empty arg from an all-dash name (review finding)', () => {
    expect(clampPodName('---')).toBe('untitled')
    expect(clampPodName('-- ')).toBe('untitled')
    expect(clampPodName('   ')).toBe('untitled')
  })
})
