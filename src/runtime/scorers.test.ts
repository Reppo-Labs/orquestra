// src/runtime/scorers.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildScorers, effectiveDefaultModel, type ScorerEnv } from './scorers.js'
import { StrategyConfigSchema } from '../config/schema.js'
import type { LlmProvider } from '../llm/model.js'
import type { LanguageModel } from 'ai'

// No LLM call is ever made here: buildScorers only CONSTRUCTS scorers. The resolver is
// injected (the seam index.ts already uses for oauth) and returns a sentinel object, so
// these tests exercise resolution + the scorer cache in isolation from the SDK.
const sentinelResolver = () =>
  vi.fn((provider: string, _key: string, model?: string) => ({ provider, model } as unknown as LanguageModel))

const cfg = (datanets: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  StrategyConfigSchema.parse({
    horizonDays: 7, cadenceHours: 1,
    stake: { lockReppo: 0, lockDurationDays: 7 },
    budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 100, mintGasEthMax: 1 },
    datanets, notes: '', ...over,
  })

function env(over: Partial<ScorerEnv> = {}): ScorerEnv {
  return {
    dataDir: '/nonexistent-scorers-test', // liveLessons tolerates a missing DB (returns '')
    config: cfg({ '9': { vote: true, mint: false, strictness: 'balanced' } }),
    providerKeyRegistry: new Map<LlmProvider, string>([['virtuals', 'acp-v']]),
    defaultProvider: 'virtuals',
    defaultModel: 'claude-opus-4-8',
    resolveModel: sentinelResolver(),
    ...over,
  }
}

describe('buildScorers voteScorerFor', () => {
  it('resolves a scorer via the node default provider; repeat calls return the cached object', () => {
    const s = buildScorers(env())
    const a = s.voteScorerFor('9')
    expect('scorer' in a).toBe(true)
    const b = s.voteScorerFor('9')
    expect((b as { scorer: unknown }).scorer).toBe((a as { scorer: unknown }).scorer)
  })

  it('skips (never caches a scorer) when the datanet policy model has no key', () => {
    const s = buildScorers(env({
      config: cfg({ '9': { vote: true, mint: false, strictness: 'balanced', model: { provider: 'google', model: 'gemini-3-pro' } } }),
    }))
    const r = s.voteScorerFor('9')
    expect('skip' in r).toBe(true)
    expect((r as { skip: string }).skip).toContain('google')
    // still a skip on repeat — nothing got cached for an unresolvable model
    expect('skip' in s.voteScorerFor('9')).toBe(true)
  })

  it('cache key is the resolved provider:model — datanets sharing it share ONE scorer', () => {
    const s = buildScorers(env({
      config: cfg({
        '9': { vote: true, mint: false, strictness: 'balanced' },   // node default
        '10': { vote: true, mint: false, strictness: 'balanced' },  // node default too
        // explicit policy model identical to the node default → SAME cache key
        '11': { vote: true, mint: false, strictness: 'balanced', model: { provider: 'virtuals', model: 'claude-opus-4-8' } },
      }),
    }))
    const nine = s.voteScorerFor('9'), ten = s.voteScorerFor('10'), eleven = s.voteScorerFor('11')
    expect((nine as { scorer: unknown }).scorer).toBe((ten as { scorer: unknown }).scorer)
    expect((eleven as { scorer: unknown }).scorer).toBe((nine as { scorer: unknown }).scorer)
  })

  it('distinct resolved models get distinct scorers (no cache collision)', () => {
    const s = buildScorers(env({
      config: cfg({
        '9': { vote: true, mint: false, strictness: 'balanced' },
        '11': { vote: true, mint: false, strictness: 'balanced', model: { provider: 'virtuals', model: 'other-slug' } },
      }),
    }))
    const a = s.voteScorerFor('9'), c = s.voteScorerFor('11')
    expect((a as { scorer: unknown }).scorer).not.toBe((c as { scorer: unknown }).scorer)
  })

  it('reads config.defaultModel LIVE: a hot-reloaded default resolves a NEW scorer (fresh cache key)', () => {
    const e = env({
      providerKeyRegistry: new Map<LlmProvider, string>([['virtuals', 'acp-v'], ['usepod', 'tok']]),
    })
    const s = buildScorers(e)
    const before = s.voteScorerFor('9')
    expect('scorer' in before).toBe(true)
    // buildTick swaps e.config on reload; the datanet has no policy model, so the
    // effective default (now usepod) drives resolution — and a different cache key.
    e.config = cfg({ '9': { vote: true, mint: false, strictness: 'balanced' } },
      { defaultModel: { provider: 'usepod', model: 'deepseek-v3.2' } })
    const after = s.voteScorerFor('9')
    expect('scorer' in after).toBe(true)
    expect((after as { scorer: unknown }).scorer).not.toBe((before as { scorer: unknown }).scorer)
  })

  it('the default scorer follows config.defaultModel when the env default is unkeyed', () => {
    const s = buildScorers(env({
      config: cfg({ '9': { vote: true, mint: false, strictness: 'balanced' } },
        { defaultModel: { provider: 'usepod', model: 'deepseek-v3.2' } }),
      providerKeyRegistry: new Map<LlmProvider, string>([['usepod', 'tok']]), // virtuals unkeyed
    }))
    expect('scorer' in s.voteScorerFor('9')).toBe(true) // resolved via usepod (keyed)
  })
})

describe('buildScorers candidateScorer', () => {
  it('throws when no key exists for the effective default (selectMints records it per candidate)', () => {
    const s = buildScorers(env({ providerKeyRegistry: new Map<LlmProvider, string>() }))
    expect(() => s.candidateScorer.scoreCandidate(
      { canonicalKey: 'k', podName: 'n', podDescription: 'd', dataset: {} },
      { datanetId: '9' } as never,
    )).toThrow(/no API key for the node default provider/)
  })
})

describe('effectiveDefaultModel', () => {
  it('resolves the live config default when keyed, null when nothing is keyed', () => {
    const resolveModel = sentinelResolver()
    const keyed = env({ resolveModel })
    expect(effectiveDefaultModel(keyed)).toMatchObject({ provider: 'virtuals', model: 'claude-opus-4-8' })
    expect(resolveModel).toHaveBeenCalledWith('virtuals', 'acp-v', 'claude-opus-4-8')
    expect(effectiveDefaultModel(env({ providerKeyRegistry: new Map<LlmProvider, string>() }))).toBeNull()
  })
})
