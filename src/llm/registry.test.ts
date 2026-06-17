// src/llm/registry.test.ts
import { describe, it, expect } from 'vitest'
import { buildProviderKeyRegistry } from './registry.js'

describe('buildProviderKeyRegistry', () => {
  it('reads per-provider LLM_KEY_* vars into the registry', () => {
    const r = buildProviderKeyRegistry({
      LLM_KEY_ANTHROPIC: 'sk-ant', LLM_KEY_OPENAI: 'sk-oai',
      LLM_KEY_GOOGLE: 'goog', LLM_KEY_VIRTUALS: 'acp-x', LLM_KEY_SURPLUS: 'inf_y',
    })
    expect(r.get('anthropic')).toBe('sk-ant')
    expect(r.get('openai')).toBe('sk-oai')
    expect(r.get('google')).toBe('goog')
    expect(r.get('virtuals')).toBe('acp-x')
    expect(r.get('surplus')).toBe('inf_y')
  })

  it('registers usepod from LLM_KEY_USEPOD', () => {
    const reg = buildProviderKeyRegistry({ LLM_KEY_USEPOD: 'tok_abc' })
    expect(reg.get('usepod')).toBe('tok_abc')
  })

  it('registers LLM_PROVIDER + LLM_API_KEY as the default provider key (back-compat)', () => {
    const r = buildProviderKeyRegistry({ LLM_PROVIDER: 'virtuals', LLM_API_KEY: 'acp-default' })
    expect(r.get('virtuals')).toBe('acp-default')
    expect([...r.keys()]).toEqual(['virtuals'])
  })

  it('defaults the provider to anthropic when LLM_API_KEY is set but LLM_PROVIDER is not', () => {
    const r = buildProviderKeyRegistry({ LLM_API_KEY: 'sk-ant' })
    expect(r.get('anthropic')).toBe('sk-ant')
  })

  it('a per-provider key does NOT clobber an existing default for that provider', () => {
    // explicit LLM_KEY_GOOGLE wins over the legacy default for the same provider
    const r = buildProviderKeyRegistry({ LLM_PROVIDER: 'google', LLM_API_KEY: 'old', LLM_KEY_GOOGLE: 'new' })
    expect(r.get('google')).toBe('new')
  })

  it('ignores blank/whitespace keys and an unknown LLM_PROVIDER', () => {
    const r = buildProviderKeyRegistry({ LLM_KEY_OPENAI: '  ', LLM_PROVIDER: 'mistral', LLM_API_KEY: 'x' })
    expect(r.has('openai')).toBe(false)
    expect(r.size).toBe(0)
  })

  it('empty env → empty registry', () => {
    expect(buildProviderKeyRegistry({}).size).toBe(0)
  })
})
