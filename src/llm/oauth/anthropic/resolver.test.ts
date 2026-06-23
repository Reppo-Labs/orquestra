import { describe, it, expect, vi } from 'vitest'
import { oauthAwareResolver } from './resolver.js'
import type { LanguageModel } from 'ai'
import type { LlmProvider } from '../../model.js'

const fakeModel = {} as LanguageModel

describe('oauthAwareResolver', () => {
  it('routes anthropic-oauth through resolveModel with the tokenProvider, ignoring the key sentinel', () => {
    const inner = vi.fn(() => fakeModel)
    const tokenProvider = async () => 'sk-ant-oat01-A'
    const resolve = oauthAwareResolver(tokenProvider, inner)

    resolve('anthropic-oauth', 'oauth-sentinel', 'claude-opus-4-7')

    expect(inner).toHaveBeenCalledWith('anthropic-oauth', '', 'claude-opus-4-7', { tokenProvider })
  })

  it('delegates every other provider unchanged (key passed, no oauth opts)', () => {
    const inner = vi.fn(() => fakeModel)
    const resolve = oauthAwareResolver(async () => 'unused', inner)

    for (const p of ['anthropic', 'openai', 'google', 'surplus', 'virtuals', 'usepod'] as LlmProvider[]) {
      resolve(p, 'real-key', 'some-model')
      expect(inner).toHaveBeenLastCalledWith(p, 'real-key', 'some-model')
    }
  })
})
