// src/onboarding/persist.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistOnboarding, needsOnboarding } from './persist.js'
import { loadConfig } from '../config/load.js'
import { buildStrategyConfig } from './build.js'
import type { OnboardingAnswers } from './types.js'

const ans: OnboardingAnswers = {
  datanets: [{ id: '9', vote: true, mint: true, strictness: 'balanced', adapter: 'hyperliquid' }],
  lockReppo: 500, lockDurationDays: 30, voteRateMaxPerCycle: 25,
  mintReppoMax: 100, horizonDays: 30, cadenceHours: 6, notes: 'hi',
}
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-onb-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('onboarding persistence', () => {
  it('needsOnboarding is true before, false after persisting', () => {
    expect(needsOnboarding(dir)).toBe(true)
    persistOnboarding(dir, buildStrategyConfig(ans))
    expect(needsOnboarding(dir)).toBe(false)
  })

  it('writes a config loadConfig can read back, with notes carried in config.notes', () => {
    persistOnboarding(dir, buildStrategyConfig(ans))
    const cfg = loadConfig(dir)
    expect(cfg.datanets['9'].adapter).toBe('hyperliquid')
    expect(cfg.notes).toBe('hi') // the brief lives in config.notes — no separate notes store
  })
})
