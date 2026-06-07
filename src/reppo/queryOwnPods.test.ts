// src/reppo/queryOwnPods.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseOwnPodVotes } from './queryOwnPods.js'

const raw = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/pods-list.json'), 'utf-8'))

describe('parseOwnPodVotes', () => {
  it('extracts podId, name, epoch, and numeric up/down votes', () => {
    const pods = parseOwnPodVotes(raw)
    expect(pods).toHaveLength(3)
    expect(pods[0]).toEqual({ podId: '508', name: 'HotBot v4 — Signals Jun01-03', validityEpoch: '101', upVotes: 0, downVotes: 0 })
    expect(pods[1]).toMatchObject({ podId: '492', upVotes: 2, downVotes: 0 })
  })
  it('returns [] on malformed input', () => {
    expect(parseOwnPodVotes({})).toEqual([])
    expect(parseOwnPodVotes(null)).toEqual([])
  })
  it('coerces missing votes to 0', () => {
    expect(parseOwnPodVotes({ pods: [{ podId: '7', name: 'x', validityEpoch: '1' }] })[0]).toEqual({ podId: '7', name: 'x', validityEpoch: '1', upVotes: 0, downVotes: 0 })
  })
})
