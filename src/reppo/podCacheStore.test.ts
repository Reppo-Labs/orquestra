import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeOwnerScanCache, makeVoterScanCache } from './podCacheStore.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-podcache-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('makeOwnerScanCache', () => {
  it('defaults to 0 and round-trips the per-pod watermark', () => {
    const c = makeOwnerScanCache(dir)
    expect(c.getThrough('42')).toBe(0)
    c.setThrough('42', 101)
    expect(c.getThrough('42')).toBe(101)
    c.setThrough('42', 105)
    expect(c.getThrough('42')).toBe(105)
  })

  it('is independent from the voter-scan watermark for the same pod', () => {
    const owner = makeOwnerScanCache(dir)
    const voter = makeVoterScanCache(dir)
    owner.setThrough('7', 50)
    voter.setThrough('7', 90)
    expect(owner.getThrough('7')).toBe(50)
    expect(voter.getThrough('7')).toBe(90)
  })
})
