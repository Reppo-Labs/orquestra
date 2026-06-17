import { describe, it, expect } from 'vitest'
import { resolveModel, LlmProviderEnum, DEFAULT_MODEL, KNOWN_MODELS, stripTemperature, usepodBaseURL, type LlmProvider } from './model.js'

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

  it('builds the usepod base URL with the token in the path (not a header)', () => {
    // The usepod model is wrapped (dropTemperature) so the openai client's internal
    // `config.url` isn't reachable; assert the token-in-path contract via the helper.
    expect(usepodBaseURL('TOKHERE')).toBe('https://api.usepod.ai/proxy/TOKHERE/v1')
    expect(resolveModel('usepod', 'TOKHERE', 'deepseek-v3.2')).toBeTruthy()
  })

  it('throws on an unknown provider', () => {
    expect(() => resolveModel('bogus' as LlmProvider, 'k')).toThrow(/unknown LLM provider/)
  })
})

describe('stripTemperature', () => {
  it('drops temperature (the SDK forces temperature:0; usepod open-weight models reject it)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = { temperature: 0, maxTokens: 100, prompt: 'x' } as any
    const out = stripTemperature(params)
    expect(out.temperature).toBeUndefined()
    expect(out.maxTokens).toBe(100) // other params preserved
  })
})
