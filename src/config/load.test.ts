// src/config/load.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, ConfigNotFoundError, ConfigInvalidError, resetWarnedGrantReppoMax } from './load.js'

let dir: string
const writeCfg = (obj: unknown) => writeFileSync(join(dir, 'strategy.config.json'), JSON.stringify(obj))
const goodCfg = (over: Record<string, unknown> = {}) => ({
  horizonDays: 30, cadenceHours: 6,
  stake: { lockReppo: 500, lockDurationDays: 30 },
  budget: { voteGasEthMax: 0.02, voteRateMaxPerCycle: 25, mintReppoMax: 100, mintGasEthMax: 0.05, claimGasEthMax: 0.05 },
  datanets: { '9': { vote: true, strictness: 'balanced' } },
  ...over,
})

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-')); resetWarnedGrantReppoMax() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('loadConfig', () => {
  it('throws ConfigNotFoundError when no config exists (first run)', () => {
    expect(() => loadConfig(dir)).toThrow(ConfigNotFoundError)
  })

  it('loads and validates a good config', () => {
    writeCfg({
      horizonDays: 30, cadenceHours: 6,
      stake: { lockReppo: 500, lockDurationDays: 30 },
      budget: { voteGasEthMax: 0.02, voteRateMaxPerCycle: 25, mintReppoMax: 100, mintGasEthMax: 0.05, claimGasEthMax: 0.05 },
      datanets: { '9': { vote: true, strictness: 'balanced' } },
    })
    const cfg = loadConfig(dir)
    expect(cfg.datanets['9'].vote).toBe(true)
    expect(cfg.notes).toBe('')
  })

  it('throws ConfigInvalidError with a readable message on a bad config', () => {
    writeCfg({ horizonDays: -1 })
    expect(() => loadConfig(dir)).toThrow(ConfigInvalidError)
  })

  it('warns ONCE that budget.grantReppoMax is no longer enforced when the raw config still carries it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // grantReppoMax is not in the schema; budget is not strict, so it parses + is stripped.
    writeCfg(goodCfg({ budget: { voteGasEthMax: 0.02, voteRateMaxPerCycle: 25, mintReppoMax: 100, mintGasEthMax: 0.05, claimGasEthMax: 0.05, grantReppoMax: 100 } }))
    const cfg = loadConfig(dir)
    expect((cfg.budget as Record<string, unknown>).grantReppoMax).toBeUndefined() // stripped by Zod
    loadConfig(dir) // second read must NOT warn again (warn-once latch)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/grantReppoMax is no longer enforced/)
    warn.mockRestore()
  })

  it('does NOT warn for a config without budget.grantReppoMax', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeCfg(goodCfg())
    loadConfig(dir)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
