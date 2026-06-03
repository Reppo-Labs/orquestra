// src/reppo/listPods.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePods, deriveCurrentEpoch } from './listPods.js'

const raw = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/pods-list.json'), 'utf-8'))

describe('parsePods / deriveCurrentEpoch', () => {
  it('maps pods to VoterPod (podId, validityEpoch, name, url; description defaults to name)', () => {
    const pods = parsePods(raw)
    expect(pods).toHaveLength(3)
    expect(pods[0]).toMatchObject({ podId: '508', validityEpoch: '101', name: 'HotBot v4 — Signals Jun01-03', url: 'https://gateway.pinata.cloud/ipfs/bafkA' })
    expect(pods[0].description).toBe('HotBot v4 — Signals Jun01-03') // default until content is fetched
  })
  it('deriveCurrentEpoch = max validityEpoch as a string', () => {
    expect(deriveCurrentEpoch(parsePods(raw))).toBe('101')
  })
  it('parsePods returns [] / deriveCurrentEpoch returns null on empty', () => {
    expect(parsePods({})).toEqual([])
    expect(deriveCurrentEpoch([])).toBeNull()
  })
})
