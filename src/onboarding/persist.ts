// src/onboarding/persist.ts
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILENAME } from '../config/load.js'
import type { StrategyConfig } from '../config/schema.js'

const NOTES_FILE = 'strategy-notes.md'

/** True when no config exists yet (first run → run the interview). */
export function needsOnboarding(dataDir: string): boolean {
  return !existsSync(join(dataDir, CONFIG_FILENAME))
}

/** Persist the validated config + the freeform notes to the data dir. */
export function persistOnboarding(dataDir: string, config: StrategyConfig, notes: string): void {
  writeFileSync(join(dataDir, CONFIG_FILENAME), JSON.stringify(config, null, 2))
  writeFileSync(join(dataDir, NOTES_FILE), `# Orquestra strategy notes\n\n${notes}\n`)
}
