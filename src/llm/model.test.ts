import { describe, it, expect } from 'vitest'
import { resolveModel, type LlmProvider } from './model.js'

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

  it('resolves virtuals (Anthropic-compatible gateway) with the acp- key + model override', () => {
    expect(resolveModel('virtuals', 'acp-test')).toBeTruthy()
    expect(resolveModel('virtuals', 'acp-test', 'anthropic/claude-sonnet-4-5')).toBeTruthy()
  })

  it('throws on an unknown provider', () => {
    expect(() => resolveModel('bogus' as LlmProvider, 'k')).toThrow(/unknown LLM provider/)
  })
})
