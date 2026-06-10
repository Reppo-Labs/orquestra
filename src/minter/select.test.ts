// src/minter/select.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectMints } from './select.js'
import type { CandidatePod, CandidateScorer } from '../adapter/types.js'
import type { DatanetRubric } from '../rubric/types.js'

const rubric: DatanetRubric = {
  datanetId: '9', name: 'TradingGym AI', goal: 'g', publisherSpec: 'HL perp data', voterRubric: 'v',
  canVote: true, canMint: true, status: 'ACTIVE', subnetUuid: 'cm-subnet-9',
  economics: { accessFeeReppo: 50, emissionsPerEpochReppo: 500, upVoteVolume: 1, downVoteVolume: 1, nativeTokenSymbol: 'REPPO' },
}
const cand = (key: string): CandidatePod => ({ canonicalKey: key, podName: `pod-${key}`, podDescription: 'd', dataset: { rows: [key] } })
const scorerOf = (scores: Record<string, number>): CandidateScorer => ({
  scoreCandidate: async (c) => ({ score: scores[c.canonicalKey] ?? 5, reason: `r:${c.canonicalKey}` }),
})

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-mint-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('selectMints (minScore 7)', () => {
  it('mints candidates scoring >= minScore, writes the dataset body, sets datasetPath', async () => {
    const intents = await selectMints('9', [cand('a'), cand('b')], rubric,
      { dataDir: dir, minScore: 7, seenKeys: new Set(), scorer: scorerOf({ a: 9, b: 4 }) })
    expect(intents.map((i) => i.canonicalKey)).toEqual(['a']) // b scored 4 < 7
    expect(intents[0].kind).toBe('mint'); expect(intents[0].datanetId).toBe('9')
    expect(intents[0].subnetUuid).toBe('cm-subnet-9') // carried from rubric for mint-pod --subnet-uuid
    expect(existsSync(intents[0].datasetPath)).toBe(true)
    expect(JSON.parse(readFileSync(intents[0].datasetPath, 'utf-8'))).toEqual({ rows: ['a'] })
  })

  it('dedups candidates whose canonicalKey is already in seenKeys (no score, no mint)', async () => {
    let scored: string[] = []
    const tracking: CandidateScorer = { scoreCandidate: async (c) => { scored.push(c.canonicalKey); return { score: 9, reason: '' } } }
    const intents = await selectMints('9', [cand('dup'), cand('new')], rubric,
      { dataDir: dir, minScore: 7, seenKeys: new Set(['dup']), scorer: tracking })
    expect(scored).toEqual(['new'])
    expect(intents.map((i) => i.canonicalKey)).toEqual(['new'])
  })

  it('returns [] without scoring when the rubric is not mint-capable', async () => {
    let calls = 0
    const counting: CandidateScorer = { scoreCandidate: async () => { calls++; return { score: 9, reason: '' } } }
    const intents = await selectMints('9', [cand('a')], { ...rubric, canMint: false },
      { dataDir: dir, minScore: 7, seenKeys: new Set(), scorer: counting })
    expect(intents).toEqual([]); expect(calls).toBe(0)
  })

  it('clamps an over-long candidate podName to 50 chars in the intent', async () => {
    const long = cand('klong')
    long.podName = 'A '.repeat(60) + 'end' // 123 chars
    const intents = await selectMints('9', [long], rubric,
      { dataDir: dir, minScore: 7, seenKeys: new Set(), scorer: scorerOf({ klong: 9 }) })
    expect(intents).toHaveLength(1)
    expect(intents[0].podName.length).toBeLessThanOrEqual(50)
  })

  it('clamps an over-long candidate podDescription to 200 chars in the intent', async () => {
    const long = cand('kdesc')
    long.podDescription = 'Verdict: likely (7/10). ' + 'word '.repeat(70) + 'Source: https://example.com/a' // ~400 chars
    const intents = await selectMints('9', [long], rubric,
      { dataDir: dir, minScore: 7, seenKeys: new Set(), scorer: scorerOf({ kdesc: 9 }) })
    expect(intents).toHaveLength(1)
    expect(intents[0].podDescription.length).toBeLessThanOrEqual(200)
  })

  it('carries sourceUrl + imageUrl from candidate to mint intent', async () => {
    const c = cand('k1'); c.sourceUrl = 'https://news/x'; c.imageUrl = 'https://news/x.jpg'
    const intents = await selectMints('9', [c], rubric,
      { dataDir: dir, minScore: 7, seenKeys: new Set(), scorer: scorerOf({ k1: 9 }) })
    expect(intents[0].sourceUrl).toBe('https://news/x')
    expect(intents[0].imageUrl).toBe('https://news/x.jpg')
  })

  it('carries the score onto selfScore and dedups within the same batch', async () => {
    const intents = await selectMints('9', [cand('a'), cand('a')], rubric,
      { dataDir: dir, minScore: 7, seenKeys: new Set(), scorer: scorerOf({ a: 8 }) })
    expect(intents).toHaveLength(1)           // second 'a' deduped within batch
    expect(intents[0].selfScore).toBe(8)
  })
})
