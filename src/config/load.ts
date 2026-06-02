// src/config/load.ts
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { StrategyConfigSchema, type StrategyConfig } from './schema.js'

export class ConfigNotFoundError extends Error {}
export class ConfigInvalidError extends Error {}

export const CONFIG_FILENAME = 'strategy.config.json'

/** Load + validate the strategy config from `dataDir`.
 *  Throws ConfigNotFoundError (first run → caller runs onboarding) or
 *  ConfigInvalidError (present but malformed → surface, do not silently default). */
export function loadConfig(dataDir: string): StrategyConfig {
  const path = join(dataDir, CONFIG_FILENAME)
  if (!existsSync(path)) {
    throw new ConfigNotFoundError(`No ${CONFIG_FILENAME} in ${dataDir} — run \`orquestra configure\``)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    throw new ConfigInvalidError(`${CONFIG_FILENAME} is not valid JSON: ${(e as Error).message}`)
  }
  const result = StrategyConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigInvalidError(`${CONFIG_FILENAME} failed validation:\n${result.error.toString()}`)
  }
  return result.data
}
