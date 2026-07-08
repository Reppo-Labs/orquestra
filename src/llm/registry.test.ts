// src/llm/registry.test.ts
import { describe, it, expect } from 'vitest'
import { buildProviderKeyRegistry, resolveLlmBaseUrl } from './registry.js'

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

  it('never registers anthropic-oauth via the back-compat path (availability is hasOAuthCredential, not env)', () => {
    // anthropic-oauth has no env key; setting it via LLM_PROVIDER/LLM_API_KEY must NOT
    // back-door it into the registry (else the dashboard advertises it with no token on disk).
    const r = buildProviderKeyRegistry({ LLM_PROVIDER: 'anthropic-oauth', LLM_API_KEY: 'whatever' })
    expect(r.has('anthropic-oauth')).toBe(false)
    expect(r.size).toBe(0)
  })
})

describe('resolveLlmBaseUrl', () => {
  it('undefined when nothing is set (SDK default)', () => {
    expect(resolveLlmBaseUrl('openai', {})).toBeUndefined()
  })

  it('global LLM_BASE_URL applies to every overridable provider', () => {
    const env = { LLM_BASE_URL: 'https://gw/v1' }
    expect(resolveLlmBaseUrl('openai', env)).toBe('https://gw/v1')
    expect(resolveLlmBaseUrl('anthropic', env)).toBe('https://gw/v1')
    expect(resolveLlmBaseUrl('google', env)).toBe('https://gw/v1')
  })

  it('per-provider LLM_BASE_URL_<PROVIDER> wins over the global', () => {
    const env = { LLM_BASE_URL: 'https://global/v1', LLM_BASE_URL_OPENAI: 'https://openai-gw/v1' }
    expect(resolveLlmBaseUrl('openai', env)).toBe('https://openai-gw/v1')
    expect(resolveLlmBaseUrl('anthropic', env)).toBe('https://global/v1') // no anthropic-specific → global
  })

  it('treats blank/whitespace as unset', () => {
    expect(resolveLlmBaseUrl('openai', { LLM_BASE_URL: '   ' })).toBeUndefined()
    expect(resolveLlmBaseUrl('openai', { LLM_BASE_URL_OPENAI: '', LLM_BASE_URL: 'https://gw/v1' })).toBe('https://gw/v1')
  })

  it('still returns the global for a provider with no per-provider var (marketplaces filtered downstream)', () => {
    // resolveLlmBaseUrl is provider-agnostic for the global; resolveModel decides which
    // providers actually apply it (usepod/virtuals/surplus/anthropic-oauth ignore it).
    expect(resolveLlmBaseUrl('usepod', { LLM_BASE_URL: 'https://gw/v1' })).toBe('https://gw/v1')
  })
})
