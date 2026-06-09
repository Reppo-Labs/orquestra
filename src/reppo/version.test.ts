import { describe, it, expect } from 'vitest'
import { checkReppoVersion, REQUIRED_REPPO_VERSION } from './version.js'

describe('checkReppoVersion', () => {
  it('passes silently when the CLI meets the required version', async () => {
    const warn: string[] = []
    const ok = await checkReppoVersion({ getVersion: async () => '0.8.0', warn: (m) => warn.push(m) })
    expect(ok).toBe(true)
    expect(warn).toEqual([])
  })

  it('passes for a newer version (numeric, not lexicographic)', async () => {
    expect(await checkReppoVersion({ getVersion: async () => '0.12.3', warn: () => {} })).toBe(true) // 0.12 > 0.8
    expect(await checkReppoVersion({ getVersion: async () => '0.10.0', warn: () => {} })).toBe(true) // 0.10 > 0.8 lexically would fail
    expect(await checkReppoVersion({ getVersion: async () => '1.0.0', warn: () => {} })).toBe(true)
  })

  it('anchors on the semver token, ignoring a leading number in the banner', async () => {
    expect(await checkReppoVersion({ getVersion: async () => 'reppo-cli 2024 build v0.8.0', warn: () => {} })).toBe(true)
    const warn: string[] = []
    expect(await checkReppoVersion({ getVersion: async () => 'reppo 2024 v0.5.0', warn: (m) => warn.push(m) })).toBe(false)
    expect(warn.join(' ')).toContain('0.5.0')
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
