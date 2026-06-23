// src/config/load.ts
import { readFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, type SqliteDb } from '../dashboard/db.js'
import { StrategyConfigSchema, type StrategyConfig } from './schema.js'

export class ConfigNotFoundError extends Error {}
export class ConfigInvalidError extends Error {}

/** Warn-once latch for the budget.grantReppoMax migration note (per process). */
let warnedGrantReppoMax = false
/** test hook: reset the warn-once latch. */
export function resetWarnedGrantReppoMax(): void { warnedGrantReppoMax = false }

/** Warn ONCE if a loaded config still carries the retired `budget.grantReppoMax`. The Zod
 *  schema's `budget` object is not strict, so a stray field passes silently and is stripped
 *  on parse — without this the operator never learns the cap stopped being enforced. Detect
 *  on the RAW object (before safeParse drops it). */
function warnIfRetiredGrantCap(raw: unknown): void {
  if (warnedGrantReppoMax) return
  const budget = (raw as { budget?: unknown } | null)?.budget
  if (budget != null && typeof budget === 'object' && 'grantReppoMax' in budget) {
    warnedGrantReppoMax = true
    console.warn(
      'orquestra: budget.grantReppoMax is no longer enforced — subnet-access grants are unbounded once a datanet is enabled (enabling a datanet IS the consent to pay its one-time access fee). Remove it from your config to silence this note.',
    )
  }
}

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

/** File-canonical reconcile (declarative deploy, `CONFIG_SOURCE=file`). Unlike the one-time
 *  legacy import (which renames the file after first read), this re-applies `strategy.config.json`
 *  into the `config` row on EVERY call, leaving the file in place — so a redeployed K8s ConfigMap
 *  takes effect on the next pod boot. Validates BEFORE writing: a malformed file throws
 *  ConfigInvalidError (fail fast at boot) and persists nothing. No file → no-op (`reconciled:false`),
 *  preserving any existing row. Returns whether a file was applied. */
export function reconcileConfigFile(dataDir: string): { reconciled: boolean } {
  // File-canonical mode OWNS strategy.config.json — suppress the one-time legacy importer
  // (which would rename the file away and break re-apply on the next boot) for this dir.
  configImported.add(dataDir)
  const path = join(dataDir, CONFIG_FILENAME)
  if (!existsSync(path)) return { reconciled: false }
  const raw = readFileSync(path, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new ConfigInvalidError(`strategy config is not valid JSON: ${(e as Error).message}`)
  }
  warnIfRetiredGrantCap(parsed)
  const result = StrategyConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new ConfigInvalidError(`strategy config failed validation:\n${result.error.toString()}`)
  }
  // Store the raw text (parity with the import path — validation happens on read too).
  getDb(dataDir)
    .prepare('INSERT INTO config (id, data, updatedTs) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updatedTs = excluded.updatedTs')
    .run(raw, new Date().toISOString())
  return { reconciled: true }
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
  // Migration note: detect the retired budget.grantReppoMax on the RAW object before
  // safeParse silently strips it (budget is not a strict Zod object).
  warnIfRetiredGrantCap(raw)
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
