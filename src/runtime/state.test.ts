// src/runtime/state.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DedupState } from './state.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-st-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('DedupState', () => {
  it('records + reads voted pods and minted keys per datanet, persisted', () => {
    const s = new DedupState(dir)
    expect(s.getVotedPodIds('9')).toEqual([])
    s.recordVote('9', '508'); s.recordVote('9', '508'); s.recordVote('2', '12')
    expect(s.getVotedPodIds('9')).toEqual(['508']) // deduped
    s.recordMint('9', 'abc123')
    expect(s.getMintedKeys('9')).toEqual(['abc123'])
    expect(existsSync(join(dir, 'vote-state.json'))).toBe(true)
    const s2 = new DedupState(dir) // reload from disk
    expect(s2.getVotedPodIds('9')).toEqual(['508'])
    expect(s2.getMintedKeys('9')).toEqual(['abc123'])
    expect(s2.getVotedPodIds('2')).toEqual(['12'])
  })
  it('tolerates a missing/corrupt state file (starts empty)', () => {
    const s = new DedupState(dir)
    expect(s.getMintedKeys('9')).toEqual([])
  })
})
