// src/config/load.ts
import { readFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, type SqliteDb } from '../dashboard/db.js'
import { StrategyConfigSchema, type StrategyConfig } from './schema.js'

export class ConfigNotFoundError extends Error {}
export class ConfigInvalidError extends Error {}

/** Legacy on-disk config file, imported once into the `config` table. */
export const CONFIG_FILENAME = 'strategy.config.json'

const configImported = new Set<string>()
function conn(dataDir: string): SqliteDb {
  const d = getDb(dataDir)
  if (!configImported.has(dataDir)) {
    importLegacyConfig(d, dataDir)
    configImported.add(dataDir)
  }
  return d
}

/** One-time import of a pre-existing strategy.config.json into the empty `config`
 *  row, then rename it *.imported. The raw text is stored as-is — validation happens
 *  on read, preserving the "present but malformed → ConfigInvalidError" behavior. */
function importLegacyConfig(d: SqliteDb, dataDir: string): void {
  const n = (d.prepare('SELECT COUNT(*) AS n FROM config').get() as { n: number }).n
  if (n > 0) return
  const path = join(dataDir, CONFIG_FILENAME)
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf-8')
  d.prepare('INSERT INTO config (id, data, updatedTs) VALUES (1, ?, ?)').run(raw, new Date().toISOString())
  renameSync(path, path + '.imported')
}

/** Raw config JSON text from the `config` row, or null when unset (first run). */
export function readConfigText(dataDir: string): string | null {
  const row = conn(dataDir).prepare('SELECT data FROM config WHERE id = 1').get() as { data: string } | undefined
  return row ? row.data : null
}

/** True once a config row exists (used by onboarding to detect first run). */
export function hasConfig(dataDir: string): boolean {
  return readConfigText(dataDir) !== null
}

/** Load + validate the strategy config from `dataDir`.
 *  Throws ConfigNotFoundError (first run → caller runs onboarding) or
 *  ConfigInvalidError (present but malformed → surface, do not silently default). */
export function loadConfig(dataDir: string): StrategyConfig {
  const text = readConfigText(dataDir)
  if (text === null) {
    throw new ConfigNotFoundError(`No strategy config in ${dataDir} — run \`orquestra configure\``)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new ConfigInvalidError(`strategy config is not valid JSON: ${(e as Error).message}`)
  }
  const result = StrategyConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigInvalidError(`strategy config failed validation:\n${result.error.toString()}`)
  }
  return result.data
}

/** Persist the validated config to the single `config` row (one atomic UPSERT). */
export function writeConfig(dataDir: string, config: StrategyConfig): void {
  conn(dataDir)
    .prepare('INSERT INTO config (id, data, updatedTs) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updatedTs = excluded.updatedTs')
    .run(JSON.stringify(config), new Date().toISOString())
}
