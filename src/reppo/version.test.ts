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

  it('parses the version despite a date/build token in PREFIX, ADJACENT, or SUFFIX position', async () => {
    expect(await checkReppoVersion({ getVersion: async () => '@reppo/cli 0.8.0', warn: () => {} })).toBe(true)
    expect(await checkReppoVersion({ getVersion: async () => 'built 2024.01 reppo v0.8.0', warn: () => {} })).toBe(true)
    // date IMMEDIATELY AFTER the product name (no v between) — year token filtered
    expect(await checkReppoVersion({ getVersion: async () => 'reppo 2024.01.05 v0.8.0', warn: () => {} })).toBe(true)
    // SUFFIX trap: too-old CLI whose banner appends the node runtime must still be flagged
    const warn: string[] = []
    expect(await checkReppoVersion({ getVersion: async () => 'reppo 0.7.0 (node 20.1.0)', warn: (m) => warn.push(m) })).toBe(false)
    expect(warn.join(' ')).toContain('0.7.0')
    // too-old with a date right after the name — must still flag (year filtered, not picked)
    const warn2: string[] = []
    expect(await checkReppoVersion({ getVersion: async () => 'reppo 2024.01.05 0.5.0', warn: (m) => warn2.push(m) })).toBe(false)
    expect(warn2.join(' ')).toContain('0.5.0')
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
