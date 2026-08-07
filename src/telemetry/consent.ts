// src/telemetry/consent.ts — whether this node may transmit telemetry, and whether the
// operator has been told that it does.
//
// Telemetry is ENABLED BY DEFAULT (specs/telemetry-consent). The reason is structural, not
// commercial: the collector admits a signal only after N *distinct installs* report it
// (specs/telemetry-ingest), and an opt-in fraction of a fleet this size would never reach
// that threshold — so data would be collected, retained, and never legitimately usable.
// Default-on is what makes the threshold a working control instead of a permanent block.
//
// Two things keep default-on from being covert, and both live here:
//   1. `noticeShown` — nothing is transmitted until the operator has been shown what is
//      collected. A node that has never displayed the notice is silent, INCLUDING a node
//      upgraded from a version that predates telemetry (no record → treated as never
//      shown → one silent run). See shouldTransmit().
//   2. The env var below overrides stored state WITHOUT mutating it, so an operator can
//      kill transmission on a run they don't control (CI, a one-off `docker run`) and
//      still keep whatever decision is on disk.
//
// The default-on posture is only defensible because the payload carries nothing personal
// or identifying (specs/telemetry-payload). If that ever stops being true, this default
// must be revisited BEFORE the payload changes — not after.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** Set to any non-empty value to disable telemetry for this process, regardless of the
 *  stored decision. Deliberately read per-call rather than cached at import time so tests
 *  and long-running processes observe a change without a restart. */
export const OPT_OUT_ENV = 'ORQUESTRA_TELEMETRY_DISABLED'

const FILE = 'telemetry-consent.json'

interface ConsentState {
  /** Operator's explicit decision. Absent → the default (enabled) applies. */
  enabled: boolean
  /** True once the telemetry notice has been displayed to the operator at least once. */
  noticeShown: boolean
}

const DEFAULT_STATE: ConsentState = { enabled: true, noticeShown: false }

/** Absolute path of the consent file inside the data dir. */
export function consentPath(dataDir: string): string {
  return join(dataDir, FILE)
}

function isState(v: unknown): v is ConsentState {
  const o = v as Record<string, unknown> | null
  return !!o && typeof o.enabled === 'boolean' && typeof o.noticeShown === 'boolean'
}

/** Read stored state. A missing OR corrupt file yields the default — which is
 *  `noticeShown: false`, so a corrupt file cannot silently resume transmission: the node
 *  re-shows the notice first. Corruption degrades toward disclosure, not away from it. */
export function readConsent(dataDir: string): ConsentState {
  const path = consentPath(dataDir)
  if (!existsSync(path)) return { ...DEFAULT_STATE }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return isState(parsed) ? { enabled: parsed.enabled, noticeShown: parsed.noticeShown } : { ...DEFAULT_STATE }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/** Persist atomically (temp + rename); a torn write would read back as the default. */
function writeConsent(dataDir: string, state: ConsentState): void {
  const path = consentPath(dataDir)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}

/** Record the operator's decision, preserving whether the notice has been shown. */
export function setTelemetryEnabled(dataDir: string, enabled: boolean): void {
  writeConsent(dataDir, { ...readConsent(dataDir), enabled })
}

/** Record that the notice has been displayed. Called after the notice is actually
 *  printed — never before, or the first run would transmit without disclosure. */
export function markNoticeShown(dataDir: string): void {
  writeConsent(dataDir, { ...readConsent(dataDir), noticeShown: true })
}

/** True when the opt-out env var is set to a non-empty value. */
export function isDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[OPT_OUT_ENV] ?? '') !== ''
}

/** The operator-facing enabled state: env override first (it does not mutate the file),
 *  otherwise the stored decision, otherwise the default. Does NOT consider the notice
 *  gate — use shouldTransmit() for that. */
export function isTelemetryEnabled(dataDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isDisabledByEnv(env)) return false
  return readConsent(dataDir).enabled
}

/** True when the notice still needs to be displayed before anything may be sent. */
export function needsNotice(dataDir: string): boolean {
  return !readConsent(dataDir).noticeShown
}

/** The single gate every transmission path must pass: enabled AND already disclosed.
 *  Both conditions, in this order, are the whole difference between default-on and
 *  covert — do not split them across call sites. */
export function shouldTransmit(dataDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return isTelemetryEnabled(dataDir, env) && !needsNotice(dataDir)
}
