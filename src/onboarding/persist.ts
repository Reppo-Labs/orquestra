// src/onboarding/persist.ts
import { hasConfig, writeConfig } from '../config/load.js'
import type { StrategyConfig } from '../config/schema.js'

/** True when no config exists yet (first run → run the interview). */
export function needsOnboarding(dataDir: string): boolean {
  return !hasConfig(dataDir)
}

/** Persist the validated config to the data dir (the SQLite `config` row). The operator
 *  brief lives in config.notes (set by buildStrategyConfig) — there is no separate notes
 *  store; config.notes is the single source the runtime brief reads. */
export function persistOnboarding(dataDir: string, config: StrategyConfig): void {
  writeConfig(dataDir, config)
}
