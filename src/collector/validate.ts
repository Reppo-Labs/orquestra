// src/collector/validate.ts — the collector's front door.
//
// Everything arriving here is hostile until proven otherwise: the endpoint is
// unauthenticated by necessity (specs/telemetry-ingest), so this module's job is not to
// "parse a payload" but to decide what is allowed to become a stored row.
//
// The rule that shapes the whole file: a field is accepted only if it is on the
// allowlist AND has the expected primitive type AND, where it is a string, is drawn from
// a closed set or a bounded character class. Strings are where injection lives, and the
// only free-ish strings the schema permits are error-signature frames — which are length-
// capped, count-capped, and character-restricted here rather than trusted.
import { ALLOWLIST_FIELDS, SCHEMA_VERSION } from '../telemetry/payload.js'
import { MAX_FRAMES } from '../telemetry/signature.js'
import { MAX_PAYLOAD_BYTES } from './config.js'

export type RejectReason =
  | 'too-large'
  | 'not-json'
  | 'not-object'
  | 'unknown-field'
  | 'missing-field'
  | 'bad-schema-version'
  | 'bad-field-type'
  | 'bad-install-id'
  | 'bad-timestamp'
  | 'bad-signature'

export interface ValidReport {
  ok: true
  report: StoredReport
}
export interface InvalidReport {
  ok: false
  reason: RejectReason
}
export type ValidationResult = ValidReport | InvalidReport

/** The normalized row the collector stores. Deliberately NOT the wire payload: it is
 *  rebuilt field by field, so anything the sender added that we happen not to reject
 *  still cannot reach storage. */
export interface StoredReport {
  schemaVersion: number
  ts: string
  installId: string
  orquestraVersion: string
  nodeVersion: string
  platform: string
  arch: string
  counts: {
    cycles: number
    votes: { attempted: number; failed: number }
    mints: { attempted: number; failed: number }
    refusedBudget: number
    errors: number
  }
  errorSignatures: { errorClass: string; frames: string[] }[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

/** Character class permitted in an error class name and in a stack frame. Excludes
 *  quotes, braces, backticks, newlines, and every other character that would let a frame
 *  carry structure into whatever eventually renders it. A legitimate frame is
 *  `fnName (dist/a/b.js:42)` and fits comfortably. */
const SAFE_FRAME = /^[A-Za-z0-9_@./:$<>[\]()\- ]{1,200}$/
const SAFE_CLASS = /^[A-Za-z0-9_$]{1,64}$/
/** Version and platform strings: short, from a small real-world vocabulary. */
const SAFE_VERSION = /^[A-Za-z0-9_.\-+]{1,32}$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
}

function validCounts(v: unknown): StoredReport['counts'] | null {
  if (!isPlainObject(v)) return null
  const { cycles, votes, mints, refusedBudget, errors } = v
  if (!isNonNegativeInt(cycles) || !isNonNegativeInt(refusedBudget) || !isNonNegativeInt(errors)) return null
  const pair = (p: unknown): { attempted: number; failed: number } | null => {
    if (!isPlainObject(p)) return null
    return isNonNegativeInt(p.attempted) && isNonNegativeInt(p.failed)
      ? { attempted: p.attempted, failed: p.failed }
      : null
  }
  const v1 = pair(votes)
  const m1 = pair(mints)
  if (v1 === null || m1 === null) return null
  return { cycles, votes: v1, mints: m1, refusedBudget, errors }
}

function validSignatures(v: unknown): StoredReport['errorSignatures'] | null {
  if (!Array.isArray(v)) return null
  // Cap the array itself: an unbounded list of valid-looking signatures is a storage
  // amplification vector even when every element passes.
  if (v.length > MAX_FRAMES * 4) return null
  const out: StoredReport['errorSignatures'] = []
  for (const s of v) {
    if (!isPlainObject(s)) return null
    const { errorClass, frames } = s
    if (typeof errorClass !== 'string' || !SAFE_CLASS.test(errorClass)) return null
    if (!Array.isArray(frames) || frames.length > MAX_FRAMES) return null
    const safe: string[] = []
    for (const f of frames) {
      if (typeof f !== 'string' || !SAFE_FRAME.test(f)) return null
      safe.push(f)
    }
    out.push({ errorClass, frames: safe })
  }
  return out
}

/** Validate a raw request body. Returns the row to store, or the reason it was refused.
 *  Rejection reasons are for the collector's own metrics — they are never echoed to the
 *  sender in detail, since a precise error message is a free oracle for probing. */
export function validateReport(body: string): ValidationResult {
  if (body.length > MAX_PAYLOAD_BYTES) return { ok: false, reason: 'too-large' }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, reason: 'not-json' }
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'not-object' }

  // Unknown fields are rejected rather than ignored. A node sending a field we do not
  // know is either a version mismatch (which schemaVersion should have caught) or an
  // attempt to smuggle one; neither should be silently stored.
  const allowed = new Set<string>(ALLOWLIST_FIELDS)
  for (const k of Object.keys(parsed)) {
    if (!allowed.has(k)) return { ok: false, reason: 'unknown-field' }
  }
  for (const k of ALLOWLIST_FIELDS) {
    if (!(k in parsed)) return { ok: false, reason: 'missing-field' }
  }

  if (parsed.schemaVersion !== SCHEMA_VERSION) return { ok: false, reason: 'bad-schema-version' }

  const { ts, installId } = parsed
  if (typeof installId !== 'string' || !UUID.test(installId)) return { ok: false, reason: 'bad-install-id' }
  if (typeof ts !== 'string' || !ISO.test(ts)) return { ok: false, reason: 'bad-timestamp' }

  /** Narrow a short-vocabulary string field, or null if it fails the character class. */
  const shortStr = (v: unknown): string | null =>
    typeof v === 'string' && SAFE_VERSION.test(v) ? v : null
  const orquestraVersion = shortStr(parsed.orquestraVersion)
  const nodeVersion = shortStr(parsed.nodeVersion)
  const platform = shortStr(parsed.platform)
  const arch = shortStr(parsed.arch)
  if (orquestraVersion === null || nodeVersion === null || platform === null || arch === null) {
    return { ok: false, reason: 'bad-field-type' }
  }

  const counts = validCounts(parsed.counts)
  if (counts === null) return { ok: false, reason: 'bad-field-type' }

  const errorSignatures = validSignatures(parsed.errorSignatures)
  if (errorSignatures === null) return { ok: false, reason: 'bad-signature' }

  // Rebuilt field by field — never a spread of `parsed`.
  return {
    ok: true,
    report: {
      schemaVersion: SCHEMA_VERSION,
      ts,
      installId,
      orquestraVersion,
      nodeVersion,
      platform,
      arch,
      counts,
      errorSignatures,
    },
  }
}
