import { describe, it, expect } from 'vitest'
import { effectiveDefault } from './effectiveDefault.js'
import type { LlmProvider } from './model.js'

const reg = (entries: [LlmProvider, string][]) => new Map<LlmProvider, string>(entries)

describe('effectiveDefault', () => {
  it('uses the config default when its provider has a key', () => {
    const r = effectiveDefault({
      configDefault: { provider: 'usepod', model: 'deepseek-v3.2' },
      registry: reg([['usepod', 'tok'], ['virtuals', 'acp-x']]),
      envProvider: 'virtuals', envModel: 'claude-opus-4-8',
    })
    expect(r).toEqual({ provider: 'usepod', model: 'deepseek-v3.2', key: 'tok' })
  })

  it('falls back to the env default (with a reason) when the config provider has no key', () => {
    const r = effectiveDefault({
      configDefault: { provider: 'usepod', model: 'deepseek-v3.2' },
      registry: reg([['virtuals', 'acp-x']]),
      envProvider: 'virtuals', envModel: 'claude-opus-4-8',
    })
    expect(r.provider).toBe('virtuals')
    expect(r.model).toBe('claude-opus-4-8')
    expect(r.key).toBe('acp-x')
    expect(r.usedFallback).toMatch(/usepod/)
  })

  it('uses the env default when no config default is set', () => {
    const r = effectiveDefault({
      configDefault: undefined,
      registry: reg([['virtuals', 'acp-x']]),
      envProvider: 'virtuals', envModel: 'claude-opus-4-8',
    })
    expect(r).toEqual({ provider: 'virtuals', model: 'claude-opus-4-8', key: 'acp-x' })
  })

  it('returns an empty key when even the env default has no key (caller treats as unavailable)', () => {
    const r = effectiveDefault({
      configDefault: undefined,
      registry: reg([]),
      envProvider: 'anthropic', envModel: 'claude-opus-4-7',
    })
    expect(r.key).toBe('')
  })
})
