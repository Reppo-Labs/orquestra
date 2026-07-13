// src/llm/resolveScoringModel.test.ts
import { describe, it, expect, vi } from 'vitest'
import { resolveScoringModel, type ModelResolver } from './resolveScoringModel.js'
import type { LanguageModel } from 'ai'
import type { LlmProvider } from './model.js'

// A LanguageModel is opaque here; resolveModel returns a real object. We only assert
// that a `model` came back (vs a `skip`), and inspect the skip reasons by string.
// Video-pod resolution is NOT here: it is owned by voter/videoPipeline.ts (scoreVideoPod)
// and tested there — this resolver is text-only by construction.
const reg = (...entries: [LlmProvider, string][]) => new Map<LlmProvider, string>(entries)

describe('resolveScoringModel', () => {
  const base = { defaultProvider: 'virtuals' as LlmProvider, defaultModel: 'claude-opus-4-8' }

  it('1) explicit policy model with a key → resolves to that model', () => {
    const r = resolveScoringModel({ policyModel: { provider: 'google', model: 'gemini-3-pro' }, registry: reg(['google', 'g'], ['virtuals', 'v']), ...base })
    expect('model' in r).toBe(true)
  })

  it('1) explicit policy model whose provider has NO key → skip with reason', () => {
    const r = resolveScoringModel({ policyModel: { provider: 'google', model: 'gemini-3-pro' }, registry: reg(['virtuals', 'v']), ...base })
    expect('skip' in r).toBe(true)
    expect((r as { skip: string }).skip).toContain('google')
  })

  it('2) no policy → resolves to the node default', () => {
    const r = resolveScoringModel({ policyModel: undefined, registry: reg(['virtuals', 'v']), ...base })
    expect('model' in r).toBe(true)
  })

  it('2) no policy + default provider has NO key → skip', () => {
    const r = resolveScoringModel({ policyModel: undefined, registry: reg(['google', 'g']), ...base })
    expect((r as { skip: string }).skip).toContain('no API key for the node default provider')
  })

  // Routing: assert the OVERRIDE's provider/slug/key are actually applied (not just that a
  // model came back). An injected resolver records its args without an SDK round-trip.
  it('applies the override provider + slug + that provider key to resolveModel', () => {
    const stub = {} as LanguageModel
    const spy = vi.fn<ModelResolver>(() => stub)
    const r = resolveScoringModel(
      { policyModel: { provider: 'google', model: 'gemini-3-pro' }, registry: reg(['google', 'gkey'], ['virtuals', 'v']), ...base },
      spy,
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('google', 'gkey', 'gemini-3-pro')
    expect((r as { model: LanguageModel }).model).toBe(stub)
  })

  it('node default (no override) resolves the default provider + default slug', () => {
    const spy = vi.fn<ModelResolver>(() => ({} as LanguageModel))
    resolveScoringModel({ policyModel: undefined, registry: reg(['virtuals', 'vkey']), ...base }, spy)
    expect(spy).toHaveBeenCalledWith('virtuals', 'vkey', 'claude-opus-4-8')
  })
})
