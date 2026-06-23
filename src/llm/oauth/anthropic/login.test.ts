import { describe, it, expect, vi } from 'vitest'
import { loginAnthropic } from './login.js'
import type { TokenSet } from './pkce.js'

const TOKENS: TokenSet = { access_token: 'sk-ant-oat01-A', refresh_token: 'sk-ant-ort01-R', expires_at: 9_000_000 }

describe('loginAnthropic', () => {
  it('runs the PKCE flow: shows the authorize URL, exchanges the pasted code, persists the tokens', async () => {
    const generatePkce = () => ({ verifier: 'VER', challenge: 'CHAL', state: 'STATE' })
    const buildAuthorizeUrl = vi.fn(({ challenge, state }: { challenge: string; state: string }) => `https://auth?c=${challenge}&s=${state}`)
    const exchangeCode = vi.fn(async () => TOKENS)
    const prompt = vi.fn(async (_url: string) => '  THE_CODE#THE_STATE  ')
    const save = vi.fn()
    const info = vi.fn()

    await loginAnthropic({ generatePkce, buildAuthorizeUrl, exchangeCode, prompt, save, info })

    expect(buildAuthorizeUrl).toHaveBeenCalledWith({ challenge: 'CHAL', state: 'STATE' })
    expect(prompt).toHaveBeenCalledWith('https://auth?c=CHAL&s=STATE')
    expect(exchangeCode).toHaveBeenCalledWith({ codeAndState: 'THE_CODE#THE_STATE', verifier: 'VER', expectedState: 'STATE' })
    expect(save).toHaveBeenCalledWith(TOKENS)
    expect(info).toHaveBeenCalledOnce()
  })

  it('aborts without saving when no code is pasted', async () => {
    const save = vi.fn()
    await expect(
      loginAnthropic({
        generatePkce: () => ({ verifier: 'v', challenge: 'c', state: 's' }),
        buildAuthorizeUrl: () => 'https://auth',
        exchangeCode: vi.fn(),
        prompt: async () => '   ',
        save,
      }),
    ).rejects.toThrow(/no authorization code/i)
    expect(save).not.toHaveBeenCalled()
  })
})
