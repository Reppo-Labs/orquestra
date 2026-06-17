import { describe, it, expect } from 'vitest'
import { resolveModel, LlmProviderEnum, DEFAULT_MODEL, KNOWN_MODELS, isTemperatureUnsupportedError, withTemperatureFallback, usepodBaseURL, type LlmProvider } from './model.js'
import type { LanguageModelV1 } from 'ai'

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
    // The usepod model is wrapped (withTemperatureFallback) so the openai client's internal
    // `config.url` isn't reachable; assert the token-in-path contract via the helper.
    expect(usepodBaseURL('TOKHERE')).toBe('https://api.usepod.ai/proxy/TOKHERE/v1')
    expect(resolveModel('usepod', 'TOKHERE', 'deepseek-v3.2')).toBeTruthy()
  })

  it('throws on an unknown provider', () => {
    expect(() => resolveModel('bogus' as LlmProvider, 'k')).toThrow(/unknown LLM provider/)
  })
})

describe('isTemperatureUnsupportedError', () => {
  it('is TRUE when the message names temperature AND a rejection word', () => {
    expect(isTemperatureUnsupportedError(new Error('temperature is deprecated for this model'))).toBe(true)
    expect(isTemperatureUnsupportedError(new Error('temperature is not supported'))).toBe(true)
    expect(isTemperatureUnsupportedError(new Error("Unsupported value: 'temperature'"))).toBe(true)
  })
  it('is FALSE for unrelated errors or temperature without a rejection word', () => {
    expect(isTemperatureUnsupportedError(new Error('rate limit exceeded'))).toBe(false)
    expect(isTemperatureUnsupportedError(new Error('high temperature warning'))).toBe(false)
  })
})

describe('withTemperatureFallback', () => {
  // A minimal LanguageModelV1 whose doGenerate rejects `temperature` (like usepod/deepseek):
  // it throws an isTemperatureUnsupportedError when temperature is set, resolves when undefined.
  function makeRejectingModel(modelId: string) {
    const calls: Array<{ temperature: number | undefined }> = []
    const model = {
      specificationVersion: 'v1',
      provider: 'fake',
      modelId,
      defaultObjectGenerationMode: 'json',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doGenerate: async (opts: any) => {
        calls.push({ temperature: opts.temperature })
        if (opts.temperature != null) throw new Error('temperature is deprecated for this model')
        return { text: 'ok', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 }, rawCall: { rawPrompt: null, rawSettings: {} } }
      },
      doStream: async () => { throw new Error('not used') },
    } as unknown as LanguageModelV1
    return { model, calls }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const genParams = (temperature: number | undefined): any => ({
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    temperature,
  })

  it('retries stripped on a temperature-rejection, then latches the modelId for later calls', async () => {
    const { model, calls } = makeRejectingModel('fake-reject-1')
    const wrapped = withTemperatureFallback(model)

    // (a) first call WITH temperature: original throws, wrapper retries stripped and succeeds.
    const r1 = await wrapped.doGenerate(genParams(0))
    expect(r1.text).toBe('ok')
    expect(calls).toEqual([{ temperature: 0 }, { temperature: undefined }]) // tried then stripped

    // (b) second call WITH temperature: modelId is latched, so it strips UP FRONT —
    // doGenerate is never invoked with a temperature again (no failed round-trip).
    calls.length = 0
    const r2 = await wrapped.doGenerate(genParams(0))
    expect(r2.text).toBe('ok')
    expect(calls).toEqual([{ temperature: undefined }]) // stripped proactively, single call
  })

  it('does not strip when the model accepts temperature (deterministic 0 preserved)', async () => {
    const calls: Array<{ temperature: number | undefined }> = []
    const accepting = {
      specificationVersion: 'v1',
      provider: 'fake',
      modelId: 'fake-accept-1',
      defaultObjectGenerationMode: 'json',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doGenerate: async (opts: any) => {
        calls.push({ temperature: opts.temperature })
        return { text: 'ok', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 }, rawCall: { rawPrompt: null, rawSettings: {} } }
      },
      doStream: async () => { throw new Error('not used') },
    } as unknown as LanguageModelV1
    const wrapped = withTemperatureFallback(accepting)
    const r = await wrapped.doGenerate(genParams(0))
    expect(r.text).toBe('ok')
    expect(calls).toEqual([{ temperature: 0 }]) // passed through untouched
  })
})
