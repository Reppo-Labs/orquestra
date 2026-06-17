// src/llm/generate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import type { CoreMessage, LanguageModel } from 'ai'

const h = vi.hoisted(() => ({ generateObject: vi.fn() }))
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateObject: h.generateObject }))

import { generateObjectWithRetry } from './generate.js'

const schema = z.object({ n: z.number() })
const model = {} as LanguageModel

beforeEach(() => h.generateObject.mockReset())

describe('generateObjectWithRetry', () => {
  it('prompt path passes { system, prompt } and returns the object', async () => {
    h.generateObject.mockResolvedValueOnce({ object: { n: 1 } })
    const out = await generateObjectWithRetry(model, schema, 'sys', { prompt: 'hello' })
    expect(out).toEqual({ n: 1 })
    expect(h.generateObject).toHaveBeenCalledWith(expect.objectContaining({ model, schema, mode: 'tool', system: 'sys', prompt: 'hello' }))
  })

  it('messages path passes { system, messages } (no prompt)', async () => {
    const messages: CoreMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    h.generateObject.mockResolvedValueOnce({ object: { n: 2 } })
    const out = await generateObjectWithRetry(model, schema, 'sys', { messages })
    expect(out).toEqual({ n: 2 })
    const call = h.generateObject.mock.calls[0][0]
    expect(call.messages).toBe(messages)
    expect(call.prompt).toBeUndefined()
  })

  it('falls back to json mode when tool mode fails (open-weight model: tool not called)', async () => {
    h.generateObject
      .mockRejectedValueOnce(new Error('No object generated: the tool was not called'))
      .mockResolvedValueOnce({ object: { n: 7 } })
    const out = await generateObjectWithRetry(model, schema, 'sys', { prompt: 'x' })
    expect(out).toEqual({ n: 7 })
    expect(h.generateObject).toHaveBeenCalledTimes(2)
    expect(h.generateObject.mock.calls[0][0].mode).toBe('tool') // attempt 1: function-calling
    expect(h.generateObject.mock.calls[1][0].mode).toBe('json') // attempt 2: json fallback
  })

  it('retries once then throws on a persistently non-conforming response', async () => {
    // vitest 2.1 records a throw/reject from a vi.mock'd module fn in mock.results and
    // reports it as a test error at teardown EVEN when the code under test caught it
    // (the runner's "errored" tracking outlives our try/catch). Clear the recorded
    // results after asserting so the proven catch+retry+rethrow isn't flagged spuriously.
    h.generateObject.mockImplementation(async () => { throw new Error('did not match schema') })
    let caught: unknown
    try {
      await generateObjectWithRetry(model, schema, 'sys', { prompt: 'x' })
    } catch (e) {
      caught = e
    }
    expect((caught as Error)?.message).toBe('did not match schema') // rethrown after retry
    expect(h.generateObject).toHaveBeenCalledTimes(2) // initial attempt + one retry
    h.generateObject.mockReset() // drop the recorded thrown results (teardown safety)
  })
})
