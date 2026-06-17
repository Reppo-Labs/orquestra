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
    for (const p of ['anthropic', 'openai', 'google', 'surplus', 'virtuals', 'usepod'] as LlmProvider[]) {
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

  it('resolves usepod (OpenAI-compatible, token-in-URL) with a model override', () => {
    expect(resolveModel('usepod', 'tok_test')).toBeTruthy()
    expect(resolveModel('usepod', 'tok_test', 'deepseek-v3.2')).toBeTruthy()
  })

  it('builds the usepod base URL from the token (token in the path, not a header)', () => {
    const m = resolveModel('usepod', 'TOKHERE', 'deepseek-v3.2') as unknown as {
      config?: { url?: (opts: { path: string; modelId: string }) => string }
    }
    // The installed @ai-sdk/openai does NOT expose a plain `config.baseURL`; the
    // configured base URL is captured in the `config.url({ path, modelId })` closure
    // (it returns `<baseURL><path>`). Assert the token rides in that URL path.
    const url = m.config?.url?.({ path: '/chat/completions', modelId: 'deepseek-v3.2' })
    expect(url).toBe('https://api.usepod.ai/proxy/TOKHERE/v1/chat/completions')
  })

  it('throws on an unknown provider', () => {
    expect(() => resolveModel('bogus' as LlmProvider, 'k')).toThrow(/unknown LLM provider/)
  })
})
