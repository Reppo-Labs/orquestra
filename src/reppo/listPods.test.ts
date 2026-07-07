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
  it('uses the CLI description (full writeup) when present, not the title', () => {
    const [p] = parsePods({ pods: [{ podId: '1', validityEpoch: '5', name: 'Netanyahu out by 2026?', description: 'ArAIstotle YES 0.45 | full analysis + sources…', url: 'https://araistotle.facticity.ai/terminal/market/1', mediaUrl: 'https://cdn/x.png' }] })
    expect(p.description).toBe('ArAIstotle YES 0.45 | full analysis + sources…')
    // The CLI's mediaUrl (a thumbnail IMAGE) must NOT land on VoterPod.mediaUrl —
    // that field means "detected video" and routes the pod to Gemini video ingest
    // (score.ts: isVideo = !!pod.mediaUrl). Regression guard.
    expect(p.mediaUrl).toBeUndefined()
  })
  it('falls back to the title when description is absent or blank (older CLI / no writeup)', () => {
    expect(parsePods({ pods: [{ podId: '1', name: 'Title only', validityEpoch: '5' }] })[0].description).toBe('Title only')
    expect(parsePods({ pods: [{ podId: '2', name: 'Title', description: '   ', validityEpoch: '5' }] })[0].description).toBe('Title')
  })
})
