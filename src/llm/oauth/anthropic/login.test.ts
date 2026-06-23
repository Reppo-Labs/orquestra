import { describe, it, expect, vi } from 'vitest'
import { loginAnthropic } from './login.js'

describe('loginAnthropic', () => {
  it('mints a token via `claude setup-token` and persists it', async () => {
    const exec = vi.fn(async () => 'prefix\nsk-ant-oat01-TOKEN123\nDone.')
    const save = vi.fn()
    const info = vi.fn()

    await loginAnthropic({ exec, save, info })

    expect(exec).toHaveBeenCalledWith('claude', ['setup-token'])
    expect(save).toHaveBeenCalledWith({ access_token: 'sk-ant-oat01-TOKEN123' })
    expect(info).toHaveBeenCalledOnce()
  })

  it('does not persist when the CLI fails', async () => {
    const save = vi.fn()
    await expect(
      loginAnthropic({ exec: async () => { throw new Error('spawn claude ENOENT') }, save }),
    ).rejects.toThrow(/claude/i)
    expect(save).not.toHaveBeenCalled()
  })
})
