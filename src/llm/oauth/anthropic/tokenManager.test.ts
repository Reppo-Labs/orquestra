import { describe, it, expect, vi } from 'vitest'
import { createTokenManager } from './tokenManager.js'

describe('createTokenManager', () => {
  it('returns the stored access token', async () => {
    const tm = createTokenManager({ load: () => ({ access_token: 'sk-ant-oat01-A' }) })
    expect(await tm.getAccessToken()).toBe('sk-ant-oat01-A')
  })

  it('throws when there is no stored credential (operator never logged in)', async () => {
    const tm = createTokenManager({ load: () => null })
    await expect(tm.getAccessToken()).rejects.toThrow(/login-anthropic/)
  })

  it('re-reads on every call, so a re-login is picked up without a restart', async () => {
    const load = vi.fn()
      .mockReturnValueOnce({ access_token: 'sk-ant-oat01-OLD' })
      .mockReturnValueOnce({ access_token: 'sk-ant-oat01-NEW' })
    const tm = createTokenManager({ load })
    expect(await tm.getAccessToken()).toBe('sk-ant-oat01-OLD')
    expect(await tm.getAccessToken()).toBe('sk-ant-oat01-NEW')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
