import { describe, it, expect } from 'vitest'
import { checkReppoVersion, REQUIRED_REPPO_VERSION } from './version.js'

describe('checkReppoVersion', () => {
  it('passes silently when the CLI meets the required version', async () => {
    const warn: string[] = []
    const ok = await checkReppoVersion({ getVersion: async () => '0.8.0', warn: (m) => warn.push(m) })
    expect(ok).toBe(true)
    expect(warn).toEqual([])
  })

  it('passes for a newer version', async () => {
    expect(await checkReppoVersion({ getVersion: async () => '0.12.3', warn: () => {} })).toBe(true)
    expect(await checkReppoVersion({ getVersion: async () => '1.0.0', warn: () => {} })).toBe(true)
  })

  it('warns loudly, naming both versions, when the CLI is too old', async () => {
    const warn: string[] = []
    const ok = await checkReppoVersion({ getVersion: async () => '0.5.0', warn: (m) => warn.push(m) })
    expect(ok).toBe(false)
    expect(warn.join(' ')).toContain('0.5.0')
    expect(warn.join(' ')).toContain(REQUIRED_REPPO_VERSION)
  })

  it('warns (but does not crash) when the CLI is missing or version is unparseable', async () => {
    const warn: string[] = []
    const ok = await checkReppoVersion({ getVersion: async () => { throw new Error('ENOENT: reppo not found') }, warn: (m) => warn.push(m) })
    expect(ok).toBe(false)
    expect(warn.join(' ')).toMatch(/could not determine/i)
  })
})
