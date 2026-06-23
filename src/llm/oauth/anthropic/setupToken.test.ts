import { describe, it, expect, vi } from 'vitest'
import { parseSetupTokenOutput, runSetupToken } from './setupToken.js'

describe('parseSetupTokenOutput', () => {
  it('extracts a single-line sk-ant-oat token', () => {
    const out = 'Visit https://...\nYour token:\nsk-ant-oat01-ABCDEF123456\nDone.'
    expect(parseSetupTokenOutput(out)).toBe('sk-ant-oat01-ABCDEF123456')
  })

  it('stops at the newline, ignoring following prose', () => {
    const out = 'token:\nsk-ant-oat01-ABC_123-xyz\nDone. Paste this into your env.'
    expect(parseSetupTokenOutput(out)).toBe('sk-ant-oat01-ABC_123-xyz')
  })

  it('throws when no sk-ant-oat token is present', () => {
    expect(() => parseSetupTokenOutput('error: login cancelled')).toThrow(/sk-ant-oat/)
  })
})

describe('runSetupToken', () => {
  it('runs `claude setup-token` and returns the parsed token', async () => {
    const exec = vi.fn(async () => 'prefix\nsk-ant-oat01-TOKEN12345\n')
    expect(await runSetupToken(exec)).toBe('sk-ant-oat01-TOKEN12345')
    expect(exec).toHaveBeenCalledWith('claude', ['setup-token'])
  })

  it('surfaces a clear error when the claude CLI is missing', async () => {
    const exec = vi.fn(async () => { throw new Error('spawn claude ENOENT') })
    await expect(runSetupToken(exec)).rejects.toThrow(/claude/i)
  })
})
