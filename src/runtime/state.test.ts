// src/runtime/state.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
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
  it('starts empty when the state file is missing', () => {
    const s = new DedupState(dir)
    expect(s.getMintedKeys('9')).toEqual([])
  })

  it('starts empty (does not throw) when the state file is corrupt', () => {
    writeFileSync(join(dir, 'vote-state.json'), '{ not valid json')
    const s = new DedupState(dir)
    expect(s.getVotedPodIds('9')).toEqual([])
    expect(s.getMintedKeys('9')).toEqual([])
  })
})

describe('DedupState claimedKeys', () => {
  it('records and reads claimed (pod:epoch) keys globally (deduped, not datanet-scoped)', () => {
    const s = new DedupState(dir)
    s.recordClaim('1:101')
    s.recordClaim('2:101')
    s.recordClaim('1:101') // duplicate ignored
    expect(new Set(s.getClaimedKeys())).toEqual(new Set(['1:101', '2:101']))
  })

  it('persists claimedKeys (flat array) to disk and reloads', () => {
    new DedupState(dir).recordClaim('1:101')
    const onDisk = JSON.parse(readFileSync(join(dir, 'vote-state.json'), 'utf-8'))
    expect(onDisk.claimedKeys).toContain('1:101')
    expect(new DedupState(dir).getClaimedKeys()).toContain('1:101') // reload
  })
})
