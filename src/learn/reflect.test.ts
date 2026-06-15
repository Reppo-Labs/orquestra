import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrategyConfigSchema } from '../config/schema.js'
import { _resetDbs } from '../dashboard/db.js'

vi.mock('../llm/generate.js', () => ({ generateObjectWithRetry: vi.fn() }))
import { generateObjectWithRetry } from '../llm/generate.js'
import { buildReflectionPrompt, ReflectionSchema, runReflection, MIN_SAMPLE, MIN_SAMPLE_PROPOSAL } from './reflect.js'
import { upsertOutcome, readLessons, readProposals, type OutcomeRow } from './store.js'
import type { LearnStats } from './stats.js'

const gen = generateObjectWithRetry as unknown as Mock

const stats = (over: Partial<LearnStats> = {}): LearnStats => ({
  datanetId: '9', maturedTotal: 20, voteTotal: 18, voteAlignmentPct: 60, upVoteTotal: 12, upVoteAlignedPct: 50,
  downVoteTotal: 6, downVoteAlignedPct: 80, mintTotal: 2, mintAlignmentPct: 50,
  highConvictionTotal: 8, highConvictionAlignedPct: 40, lowConvictionTotal: 3, lowConvictionAlignedPct: 70,
  highConvictionReversals: 3, sampleEpochs: 4, ...over,
})

const cfg = () => StrategyConfigSchema.parse({
  horizonDays: 30, cadenceHours: 6, stake: { lockReppo: 0, lockDurationDays: 30 },
  budget: { voteRateMaxPerCycle: 30, mintReppoMax: 100 },
  deliberation: { enabled: true, votePanel: true },
  datanets: { '9': { vote: true, mint: false, strictness: 'balanced' } },
})

describe('buildReflectionPrompt (pure)', () => {
  it('embeds the numbers and forbids consensus-following', () => {
    const { system, prompt } = buildReflectionPrompt('9', stats(), { strictness: 'balanced' })
    expect(prompt).toContain('aligned 60%')
    expect(prompt).toContain('high-conviction reversals')
    expect(system).toMatch(/MUST NOT instruct following, matching, or predicting crowd/i)
    expect(system).toMatch(/cite a specific number/i)
  })
})

describe('ReflectionSchema', () => {
  it('accepts an empty reflection (abstain) and rejects over-long lessons', () => {
    expect(ReflectionSchema.safeParse({ lessons: [], proposals: [] }).success).toBe(true)
    expect(ReflectionSchema.safeParse({ lessons: ['x'.repeat(201)], proposals: [] }).success).toBe(false)
    expect(ReflectionSchema.safeParse({ lessons: Array(6).fill('a'), proposals: [] }).success).toBe(false)
  })
})

describe('runReflection', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-reflect-')); gen.mockReset() })
  afterEach(() => { _resetDbs(); rmSync(dir, { recursive: true, force: true }) })

  const seed = (n: number) => {
    for (let i = 0; i < n; i++) {
      const row: OutcomeRow = {
        datanetId: '9', podId: `p${i}`, kind: 'vote', direction: 'up', conviction: 8, observedEpoch: 100,
        upVotes: 9, downVotes: 1, netVotes: 8, marginPct: 0.8, aligned: 1, matured: 1, frozen: 1,
      }
      upsertOutcome(dir, row)
    }
  }

  it('abstains (no LLM call, no lessons) below the cold-start floor', async () => {
    seed(MIN_SAMPLE - 1)
    await runReflection(dir, {} as never, '9', cfg(), 101)
    expect(gen).not.toHaveBeenCalled()
    expect(readLessons(dir, '9', { activeOnly: true })).toHaveLength(0)
  })

  it('persists lessons once enough outcomes have matured', async () => {
    seed(MIN_SAMPLE)
    gen.mockResolvedValue({ lessons: ['high-conviction calls aligned only 40% — tighten sourcing read'], proposals: [] })
    await runReflection(dir, {} as never, '9', cfg(), 101)
    const lessons = readLessons(dir, '9', { activeOnly: true })
    expect(lessons).toHaveLength(1)
    expect(lessons[0].text).toMatch(/40%/)
  })

  it('queues a valid strictness proposal only past the higher proposal threshold', async () => {
    seed(MIN_SAMPLE_PROPOSAL)
    gen.mockResolvedValue({ lessons: [], proposals: [{ field: 'strictness', toValue: 'conservative', rationale: 'reversals 3' }] })
    await runReflection(dir, {} as never, '9', cfg(), 101)
    const props = readProposals(dir, { status: 'pending' })
    expect(props).toHaveLength(1)
    expect(props[0]).toMatchObject({ field: 'strictness', fromValue: 'balanced', toValue: 'conservative' })
  })

  it('drops a no-op or invalid strictness proposal', async () => {
    seed(MIN_SAMPLE_PROPOSAL)
    gen.mockResolvedValue({ lessons: [], proposals: [
      { field: 'strictness', toValue: 'balanced', rationale: 'no-op' },        // == current → dropped
      { field: 'strictness', toValue: 'ultra-strict', rationale: 'not a level' }, // invalid → dropped
    ] })
    await runReflection(dir, {} as never, '9', cfg(), 101)
    expect(readProposals(dir, { status: 'pending' })).toHaveLength(0)
  })

  it('supersedes prior active lessons on each reflection', async () => {
    seed(MIN_SAMPLE)
    gen.mockResolvedValue({ lessons: ['first 40%'], proposals: [] })
    await runReflection(dir, {} as never, '9', cfg(), 101)
    gen.mockResolvedValue({ lessons: ['second 50%'], proposals: [] })
    await runReflection(dir, {} as never, '9', cfg(), 102)
    const active = readLessons(dir, '9', { activeOnly: true })
    expect(active).toHaveLength(1)
    expect(active[0].text).toMatch(/second/)
  })
})
