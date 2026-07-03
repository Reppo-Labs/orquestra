import { describe, it, expect, beforeEach } from 'vitest'
import { priceFor, recordLlmUsage, resetLlmUsage, snapshotLlmUsage, withUsageTracking } from './usage.js'
import { KNOWN_MODELS } from './model.js'

beforeEach(() => resetLlmUsage())

describe('priceFor', () => {
  it('matches known models by substring', () => {
    expect(priceFor('claude-sonnet-4-5')).toEqual([3, 15])
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual([1, 5])
    expect(priceFor('gpt-4o-mini')).toEqual([0.15, 0.6])
    expect(priceFor('gemini-3-flash-preview')).toEqual([0.3, 2.5])
  })
  it('longest key wins — gpt-4o-mini is not priced as gpt-4o', () => {
    expect(priceFor('gpt-4o-mini')).not.toEqual(priceFor('gpt-4o'))
  })
  it('returns null for unknown models', () => {
    expect(priceFor('some-local-llama')).toBeNull()
  })
})

describe('usage accumulator', () => {
  it('accumulates calls and tokens per model and prices them', () => {
    recordLlmUsage('claude-sonnet-4-5', 1_000_000, 100_000)
    recordLlmUsage('claude-sonnet-4-5', 500_000, 50_000)
    const s = snapshotLlmUsage()
    expect(s.calls).toBe(2)
    expect(s.inputTokens).toBe(1_500_000)
    expect(s.outputTokens).toBe(150_000)
    // 1.5M in * $3/M + 0.15M out * $15/M = 4.5 + 2.25 = 6.75
    expect(s.estCostUsd).toBeCloseTo(6.75)
    expect(s.unpricedCalls).toBe(0)
  })

  it('unknown models count tokens but contribute null cost + unpricedCalls', () => {
    recordLlmUsage('mystery-model', 10_000, 1_000)
    const s = snapshotLlmUsage()
    expect(s.calls).toBe(1)
    expect(s.estCostUsd).toBeNull() // NOTHING priceable → null, not 0
    expect(s.unpricedCalls).toBe(1)
    expect(s.byModel['mystery-model'].estCostUsd).toBeNull()
  })

  it('mixed known+unknown: cost covers only priced models, unpricedCalls flags the rest', () => {
    recordLlmUsage('claude-haiku-4-5', 1_000_000, 0) // $1
    recordLlmUsage('mystery-model', 999_999, 999_999)
    const s = snapshotLlmUsage()
    expect(s.estCostUsd).toBeCloseTo(1)
    expect(s.unpricedCalls).toBe(1)
  })

  it('NaN/missing token fields are treated as 0, never poisoning the sums', () => {
    recordLlmUsage('claude-haiku-4-5', NaN, 500_000)
    const s = snapshotLlmUsage()
    expect(s.inputTokens).toBe(0)
    expect(s.outputTokens).toBe(500_000)
    expect(s.estCostUsd).toBeCloseTo(2.5) // 0.5M out * $5/M
  })

  it('reset zeroes the window (per-cycle semantics)', () => {
    recordLlmUsage('claude-haiku-4-5', 100, 100)
    resetLlmUsage()
    const s = snapshotLlmUsage()
    expect(s.calls).toBe(0)
    expect(s.estCostUsd).toBeNull()
  })
})

describe('withUsageTracking middleware', () => {
  // Minimal LanguageModelV1 mock (same pattern as model.test.ts's makeRejectingModel).
  // usage shape is parameterized: v1/older providers report promptTokens/completionTokens,
  // newer ones inputTokens/outputTokens — the middleware must feed the accumulator from both.
  function makeModel(modelId: string, usage: unknown) {
    return {
      specificationVersion: 'v1',
      provider: 'fake',
      modelId,
      defaultObjectGenerationMode: 'json',
      doGenerate: async () => ({
        text: 'ok', finishReason: 'stop', usage, rawCall: { rawPrompt: null, rawSettings: {} },
      }),
      doStream: async () => { throw new Error('not used') },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const genParams: any = {
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  }

  it('records promptTokens/completionTokens usage (the v1 SDK shape — the live path)', async () => {
    const wrapped = makeModel('claude-haiku-4-5', { promptTokens: 120, completionTokens: 30 })
    await withUsageTracking(wrapped).doGenerate(genParams)
    const s = snapshotLlmUsage()
    expect(s.calls).toBe(1)
    expect(s.inputTokens).toBe(120)
    expect(s.outputTokens).toBe(30)
    expect(s.byModel['claude-haiku-4-5']).toBeDefined()
  })

  it('records inputTokens/outputTokens usage (newer provider shape)', async () => {
    const wrapped = makeModel('claude-haiku-4-5', { inputTokens: 50, outputTokens: 5 })
    await withUsageTracking(wrapped).doGenerate(genParams)
    const s = snapshotLlmUsage()
    expect(s.inputTokens).toBe(50)
    expect(s.outputTokens).toBe(5)
  })

  it('malformed usage never breaks the call — result passes through, tokens count 0', async () => {
    const wrapped = makeModel('claude-haiku-4-5', 'garbage-not-an-object')
    const result = await withUsageTracking(wrapped).doGenerate(genParams)
    expect(result.text).toBe('ok') // the call itself always succeeds
    const s = snapshotLlmUsage()
    expect(s.inputTokens).toBe(0) // garbage → NaN-safe zeros, not a crash
  })

  it('missing usage object records nothing but the call still succeeds', async () => {
    const wrapped = makeModel('claude-haiku-4-5', undefined)
    const result = await withUsageTracking(wrapped).doGenerate(genParams)
    expect(result.text).toBe('ok')
    expect(snapshotLlmUsage().calls).toBe(0)
  })
})

describe('pricing coverage of KNOWN_MODELS', () => {
  // Guard against catalog/table drift: every dashboard-pickable model for the metered
  // providers must resolve a price, or the operator's cost card silently under-reports
  // (this exact drift shipped once: gemini-3.1-pro-preview missed the gemini-3-pro key).
  it('every anthropic/openai/google model in KNOWN_MODELS has a pricing entry', () => {
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      for (const slug of KNOWN_MODELS[provider]) {
        expect(priceFor(slug), `${provider}/${slug} has no pricing entry`).not.toBeNull()
      }
    }
  })
})
