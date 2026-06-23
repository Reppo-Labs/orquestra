import { describe, it, expect, vi } from 'vitest'
import { createTokenManager } from './tokenManager.js'
import type { TokenSet } from './pkce.js'

const set = (over: Partial<TokenSet> = {}): TokenSet => ({
  access_token: 'sk-ant-oat01-A',
  refresh_token: 'sk-ant-ort01-R',
  expires_at: 1_000_000,
  ...over,
})

describe('createTokenManager', () => {
  it('returns the cached access token when it is still fresh', async () => {
    const refresh = vi.fn()
    const tm = createTokenManager({
      load: () => set({ expires_at: 1_000_000 }),
      save: vi.fn(),
      refresh,
      now: () => 500_000, // well before expiry
    })
    expect(await tm.getAccessToken()).toBe('sk-ant-oat01-A')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes when expired, persists the rotated set, and returns the new token', async () => {
    const save = vi.fn()
    const refreshed = set({ access_token: 'sk-ant-oat01-NEW', refresh_token: 'sk-ant-ort01-NEW', expires_at: 9_000_000 })
    const refresh = vi.fn(async () => refreshed)
    const tm = createTokenManager({
      load: () => set({ expires_at: 1_000_000 }),
      save,
      refresh,
      now: () => 2_000_000, // past expiry
    })
    expect(await tm.getAccessToken()).toBe('sk-ant-oat01-NEW')
    expect(refresh).toHaveBeenCalledWith('sk-ant-ort01-R')
    expect(save).toHaveBeenCalledWith(refreshed)
  })

  it('refreshes within the skew window (before the hard expiry)', async () => {
    const refresh = vi.fn(async () => set({ access_token: 'sk-ant-oat01-NEW' }))
    const tm = createTokenManager({
      load: () => set({ expires_at: 1_000_000 }),
      save: vi.fn(),
      refresh,
      now: () => 1_000_000 - 30_000, // inside the default 60s skew
    })
    expect(await tm.getAccessToken()).toBe('sk-ant-oat01-NEW')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('throws when there is no stored credential (operator never logged in)', async () => {
    const tm = createTokenManager({ load: () => null, save: vi.fn(), refresh: vi.fn(), now: () => 0 })
    await expect(tm.getAccessToken()).rejects.toThrow(/login-anthropic/)
  })

  it('dedupes concurrent refreshes into a single token-endpoint call', async () => {
    let resolveRefresh!: (t: TokenSet) => void
    const refresh = vi.fn(() => new Promise<TokenSet>((r) => { resolveRefresh = r }))
    const tm = createTokenManager({
      load: () => set({ expires_at: 1_000_000 }),
      save: vi.fn(),
      refresh,
      now: () => 2_000_000,
    })
    const a = tm.getAccessToken()
    const b = tm.getAccessToken()
    resolveRefresh(set({ access_token: 'sk-ant-oat01-NEW', expires_at: 9_000_000 }))
    expect(await a).toBe('sk-ant-oat01-NEW')
    expect(await b).toBe('sk-ant-oat01-NEW')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('reuses the refreshed token on the next call without refreshing again', async () => {
    const refresh = vi.fn(async () => set({ access_token: 'sk-ant-oat01-NEW', expires_at: 9_000_000 }))
    let nowMs = 2_000_000
    const tm = createTokenManager({
      load: () => set({ expires_at: 1_000_000 }),
      save: vi.fn(),
      refresh,
      now: () => nowMs,
    })
    expect(await tm.getAccessToken()).toBe('sk-ant-oat01-NEW')
    nowMs = 3_000_000 // still before the new 9_000_000 expiry
    expect(await tm.getAccessToken()).toBe('sk-ant-oat01-NEW')
    expect(refresh).toHaveBeenCalledOnce()
  })
})
