// src/config/validate.ts — pure validation of a strategy-config JSON string against the
// canonical Zod schema. Shared by the `validate-config` CLI subcommand (fail-fast in CI /
// before deploy) and the file-canonical reconcile path. Returns a discriminated result
// instead of throwing, so callers choose how to surface it.
import { StrategyConfigSchema, type StrategyConfig } from './schema.js'

export type ValidateResult =
  | { ok: true; config: StrategyConfig }
  | { ok: false; error: string }

/** Parse + validate config JSON text. Never throws. */
export function validateConfigText(text: string): ValidateResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` }
  }
  const result = StrategyConfigSchema.safeParse(raw)
  if (!result.success) {
    return { ok: false, error: result.error.toString() }
  }
  return { ok: true, config: result.data }
}
