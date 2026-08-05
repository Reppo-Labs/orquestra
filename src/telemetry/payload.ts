// src/telemetry/payload.ts — what leaves the node, and nothing else.
//
// ── Why this file is an ALLOWLIST ────────────────────────────────────────────────────
// The payload is assembled by NAMING each field. It is never built by serializing an
// internal object and removing unwanted keys. The difference decides the failure mode of
// every future change to this codebase:
//
//   denylist:  someone adds a field to Snapshot  ->  it is TRANSMITTED by default
//   allowlist: someone adds a field to Snapshot  ->  it is DROPPED by default
//
// That matters more here than in most projects. Telemetry is default-on for every
// operator (specs/telemetry-consent), so a leaked field reaches the whole fleet at once,
// not a consenting minority. And this repo is the intended target of an automated
// improvement loop — code that edits the code that produces its own telemetry. Under a
// denylist, one careless generated diff is a disclosure; under an allowlist it is an
// omission, which a test catches and no operator is harmed by.
//
// ALLOWLIST_FIELDS below is the single source of truth. payload.test.ts asserts the built
// payload's key set equals it exactly, so adding a field to the builder without declaring
// it here fails CI, and declaring one without building it fails too.
//
// ── What must never appear ───────────────────────────────────────────────────────────
// Wallet address (in ANY form, including hashed — the node address set is small and fully
// enumerable from public chain data, so a hash is reversible by brute force over it),
// datanet/subnet ids, strategy thresholds, balances, earnings, ROI, pod names or content,
// panel transcripts, RPC URLs, and any free-text string of any origin.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getInstallId } from './identity.js'
import { readCounts, type TelemetryCounts } from './counts.js'
import type { ErrorSignature } from './signature.js'

/** Payload schema version. Bump on ANY change to the field set or to signature
 *  normalization, so the collector can group comparable reports and reject shapes it
 *  does not understand (specs/telemetry-ingest). */
export const SCHEMA_VERSION = 1

/** The complete set of top-level keys permitted on the wire. Adding an entry here is a
 *  security-relevant change and should be reviewed as one — under default-on it takes
 *  effect for every operator on their next upgrade. */
export const ALLOWLIST_FIELDS = [
  'schemaVersion',
  'ts',
  'installId',
  'orquestraVersion',
  'nodeVersion',
  'platform',
  'arch',
  'counts',
  'errorSignatures',
] as const

export type AllowlistField = (typeof ALLOWLIST_FIELDS)[number]

export interface TelemetryPayload {
  schemaVersion: number
  /** ISO timestamp at which this payload was produced. */
  ts: string
  /** Random per-install UUID. Not derived from wallet, host, or path (see identity.ts). */
  installId: string
  orquestraVersion: string
  nodeVersion: string
  platform: string
  arch: string
  counts: TelemetryCounts
  errorSignatures: ErrorSignature[]
}

/** Read this package's version. Falls back to 'unknown' rather than throwing — a version
 *  we cannot read is worth reporting as unknown, and is never worth failing a cycle over. */
function orquestraVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // dist/telemetry/ or src/telemetry/ -> package root
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8')) as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export interface BuildOptions {
  /** Signatures collected this cycle. Already normalized by signature.ts — this builder
   *  does not accept raw errors, so there is no path by which a message reaches the wire. */
  errorSignatures?: ErrorSignature[]
  /** Injectable for tests; defaults to now. */
  now?: () => Date
}

/** Build the payload. Every field is named explicitly — see the allowlist rationale above.
 *  Resist the temptation to spread an object in here; a spread is a denylist. */
export function buildPayload(dataDir: string, opts: BuildOptions = {}): TelemetryPayload {
  const now = opts.now ?? (() => new Date())
  return {
    schemaVersion: SCHEMA_VERSION,
    ts: now().toISOString(),
    installId: getInstallId(dataDir),
    orquestraVersion: orquestraVersion(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    counts: readCounts(dataDir),
    errorSignatures: opts.errorSignatures ?? [],
  }
}

/** Serialize exactly as it goes on the wire. `telemetry --show` prints this, and the
 *  sender transmits this, so the two cannot drift — the operator's ability to verify the
 *  privacy claim depends on those being the same bytes (specs/telemetry-consent). */
export function serializePayload(payload: TelemetryPayload): string {
  return JSON.stringify(payload, null, 2)
}
