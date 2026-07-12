import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrategyConfigSchema } from '../config/schema.js'
import { _resetDbs } from '../dashboard/db.js'

vi.mock('../llm/generate.js', () => ({ generateObjectWithRetry: vi.fn() }))
import { generateObjectWithRetry } from '../llm/generate.js'
import { buildReflectionPrompt, ReflectionSchema, runReflection, MIN_SAMPLE, MIN_SAMPLE_PROPOSAL } from './reflect.js'
import { upsertOutcome, readLessons, readProposals, addEconDeltas, type OutcomeRow, type EconEpochRow } from './store.js'
import type { LearnStats } from './stats.js'
import type { EconStats } from './econStats.js'

const gen = generateObjectWithRetry as unknown as Mock

const stats = (over: Partial<LearnStats> = {}): LearnStats => ({
  datanetId: '9', maturedTotal: 20, voteTotal: 18, voteAlignmentPct: 60, upVoteTotal: 12, upVoteAlignedPct: 50,
  downVoteTotal: 6, downVoteAlignedPct: 80, mintTotal: 2, mintAlignmentPct: 50,
  highConvictionTotal: 8, highConvictionAlignedPct: 40, lowConvictionTotal: 3, lowConvictionAlignedPct: 70,
  highConvictionReversals: 3, sampleEpochs: 4, ...over,
})

const econStats = (over: Partial<EconStats> = {}): EconStats => ({
  datanetId: '9', epochsCovered: 3, mintCostReppo: 100, mintCount: 2, ownerClaimedReppo: 40,
  mintRoiPct: 40, voterClaimedReppo: 5, votesCast: 20, voterReppoPerVote: 0.25,
  latestYieldPerVote: null, latestUncontested: false, ...over,
})

const cfg = () => StrategyConfigSchema.parse({
  horizonDays: 30, cadenceHours: 6, stake: { lockReppo: 0, lockDurationDays: 30 },
  budget: { voteRateMaxPerCycle: 30, mintReppoMax: 100 },
  deliberation: { enabled: true, votePanel: true },
  datanets: { '9': { vote: true, mint: false, strictness: 'balanced', voteShare: 1 } },
})

describe('buildReflectionPrompt (pure)', () => {
  it('embeds the numbers and forbids consensus-following', () => {
    const { system, prompt } = buildReflectionPrompt('9', stats(), { strictness: 'balanced' })
    expect(prompt).toContain('aligned 60%')
    expect(prompt).toContain('high-conviction reversals')
    expect(system).toMatch(/MUST NOT instruct following, matching, or predicting crowd/i)
    expect(system).toMatch(/cite a specific number/i)
  })

  it('appends an Economics block with ROI when econ has coverage', () => {
    const { prompt } = buildReflectionPrompt('9', stats(), { strictness: 'balanced' }, econStats())
    expect(prompt).toContain('## Economics')
    expect(prompt).toContain('ROI')
  })

  it('omits the Economics block — byte-identical to the no-econ prompt — when econ is undefined', () => {
    const withoutArg = buildReflectionPrompt('9', stats(), { strictness: 'balanced' })
    const withUndefined = buildReflectionPrompt('9', stats(), { strictness: 'balanced' }, undefined)
    expect(withoutArg.prompt).not.toContain('## Economics')
    expect(withUndefined.prompt).toBe(withoutArg.prompt)
  })

  it('omits the Economics block when epochsCovered is 0', () => {
    const { prompt } = buildReflectionPrompt('9', stats(), { strictness: 'balanced' }, econStats({ epochsCovered: 0 }))
    const baseline = buildReflectionPrompt('9', stats(), { strictness: 'balanced' })
    expect(prompt).not.toContain('## Economics')
    expect(prompt).toBe(baseline.prompt)
  })
})

describe('ReflectionSchema', () => {
  it('accepts an empty reflection (abstain) and rejects over-long lessons', () => {
    expect(ReflectionSchema.safeParse({ lessons: [], proposals: [] }).success).toBe(true)
    expect(ReflectionSchema.safeParse({ lessons: ['x'.repeat(201)], proposals: [] }).success).toBe(false)
    expect(ReflectionSchema.safeParse({ lessons: Array(6).fill('a'), proposals: [] }).success).toBe(false)
  })

  it('accepts mint_enable and vote_share proposal fields', () => {
    const parsed = ReflectionSchema.safeParse({
      lessons: [],
      proposals: [
        { field: 'mint_enable', toValue: 'false', rationale: 'ROI 40%' },
        { field: 'vote_share', toValue: '3', rationale: 'uncontested, aligned' },
      ],
    })
    expect(parsed.success).toBe(true)
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

  const seedEcon = (epochs: number[]) => {
    const rows: EconEpochRow[] = epochs.map((epoch) => ({
      datanetId: '9', epoch, ownerClaimedReppo: 10, voterClaimedReppo: 2, mintCostReppo: 30, mintCount: 1, votesCast: 5,
    }))
    addEconDeltas(dir, rows)
  }

  it('queues a valid mint_enable proposal once epochsCovered >= 2', async () => {
    seed(MIN_SAMPLE_PROPOSAL)
    seedEcon([100, 101])
    gen.mockResolvedValue({ lessons: [], proposals: [{ field: 'mint_enable', toValue: 'true', rationale: 'ROI strong' }] })
    await runReflection(dir, {} as never, '9', cfg(), 101)
    const props = readProposals(dir, { status: 'pending' })
    expect(props).toHaveLength(1)
    expect(props[0]).toMatchObject({ field: 'mint_enable', fromValue: 'false', toValue: 'true' })
  })

  it('rejects a mint_enable proposal when epochsCovered < 2', async () => {
    seed(MIN_SAMPLE_PROPOSAL)
    seedEcon([100])
    gen.mockResolvedValue({ lessons: [], proposals: [{ field: 'mint_enable', toValue: 'true', rationale: 'ROI strong' }] })
    await runReflection(dir, {} as never, '9', cfg(), 101)
    expect(readProposals(dir, { status: 'pending' })).toHaveLength(0)
  })

  it('rejects a mint_enable proposal with a non-boolean or no-op toValue', async () => {
    seed(MIN_SAMPLE_PROPOSAL)
    seedEcon([100, 101])
    gen.mockResolvedValue({ lessons: [], proposals: [
      { field: 'mint_enable', toValue: 'yes', rationale: 'not a bool' },
      { field: 'mint_enable', toValue: 'false', rationale: 'same as current' }, // current mint=false → no-op
    ] })
    await runReflection(dir, {} as never, '9', cfg(), 101)
    expect(readProposals(dir, { status: 'pending' })).toHaveLength(0)
  })

  it('queues a valid vote_share proposal once epochsCovered >= 2', async () => {
    seed(MIN_SAMPLE_PROPOSAL)
    seedEcon([100, 101])
    gen.mockResolvedValue({ lessons: [], proposals: [{ field: 'vote_share', toValue: '3', rationale: 'high yield, aligned' }] })
    await runReflection(dir, {} as never, '9', cfg(), 101)
    const props = readProposals(dir, { status: 'pending' })
    expect(props).toHaveLength(1)
    expect(props[0]).toMatchObject({ field: 'vote_share', fromValue: '1', toValue: '3' })
  })

  it('rejects out-of-range, non-integer, or no-op vote_share proposals', async () => {
    seed(MIN_SAMPLE_PROPOSAL)
    seedEcon([100, 101])
    gen.mockResolvedValue({ lessons: [], proposals: [
      { field: 'vote_share', toValue: '0', rationale: 'too low' },
      { field: 'vote_share', toValue: '11', rationale: 'too high' },
      { field: 'vote_share', toValue: '2.5', rationale: 'not an integer' },
      { field: 'vote_share', toValue: 'high', rationale: 'not numeric' },
    ] })
    await runReflection(dir, {} as never, '9', cfg(), 101)
    expect(readProposals(dir, { status: 'pending' })).toHaveLength(0)
  })

  it('rejects a no-op vote_share proposal equal to the current value', async () => {
    seed(MIN_SAMPLE_PROPOSAL)
    seedEcon([100, 101])
    gen.mockResolvedValue({ lessons: [], proposals: [{ field: 'vote_share', toValue: '1', rationale: 'no-op' }] })
    await runReflection(dir, {} as never, '9', cfg(), 101)
    expect(readProposals(dir, { status: 'pending' })).toHaveLength(0)
  })
})
