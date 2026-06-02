// src/config/load.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, ConfigNotFoundError, ConfigInvalidError } from './load.js'

let dir: string
const writeCfg = (obj: unknown) => writeFileSync(join(dir, 'strategy.config.json'), JSON.stringify(obj))

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('loadConfig', () => {
  it('throws ConfigNotFoundError when no config exists (first run)', () => {
    expect(() => loadConfig(dir)).toThrow(ConfigNotFoundError)
  })

  it('loads and validates a good config', () => {
    writeCfg({
      horizonDays: 30, cadenceHours: 6,
      stake: { lockReppo: 500, lockDurationDays: 30 },
      budget: { voteGasEthMax: 0.02, voteRateMaxPerCycle: 25, mintReppoMax: 100, mintGasEthMax: 0.05 },
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
})
