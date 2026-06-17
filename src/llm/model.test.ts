import { describe, it, expect } from 'vitest'
import { resolveModel, LlmProviderEnum, DEFAULT_MODEL, KNOWN_MODELS, type LlmProvider } from './model.js'

const ALL: LlmProvider[] = ['anthropic', 'openai', 'google', 'surplus', 'virtuals', 'usepod']

describe('LlmProviderEnum', () => {
  it('matches the LlmProvider union exactly', () => {
    expect([...LlmProviderEnum.options].sort()).toEqual([...ALL].sort())
  })
  it('parses a known provider and rejects an unknown one', () => {
    expect(LlmProviderEnum.parse('google')).toBe('google')
    expect(() => LlmProviderEnum.parse('mistral')).toThrow()
  })
})

describe('KNOWN_MODELS', () => {
  it('seeds at least the default model for every provider', () => {
    for (const p of ALL) {
      expect(KNOWN_MODELS[p].length).toBeGreaterThan(0)
      expect(KNOWN_MODELS[p]).toContain(DEFAULT_MODEL[p])
    }
  })
})

describe('resolveModel', () => {
  it('resolves a model for every supported provider (no network, just construction)', () => {
    for (const p of ['anthropic', 'openai', 'google', 'surplus', 'virtuals'] as LlmProvider[]) {
      expect(resolveModel(p, 'test-key')).toBeTruthy()
    }
  })

  it('resolves surplus (OpenAI-compatible) and accepts an explicit model override', () => {
    expect(resolveModel('surplus', 'inf_test')).toBeTruthy()
    expect(resolveModel('surplus', 'inf_test', 'claude-opus-4.8')).toBeTruthy()
  })

  it('resolves virtuals (OpenAI-compatible gateway) with the acp- key + model override', () => {
    expect(resolveModel('virtuals', 'acp-test')).toBeTruthy()
    expect(resolveModel('virtuals', 'acp-test', 'claude-opus-4-8')).toBeTruthy()
  })

  it('throws on an unknown provider', () => {
    expect(() => resolveModel('bogus' as LlmProvider, 'k')).toThrow(/unknown LLM provider/)
  })
})
