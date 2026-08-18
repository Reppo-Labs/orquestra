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

/** The version in git. Releases are tag-driven and nothing is committed back to main, so
 *  this literal never moves — the release workflow stamps the real version into the
 *  IMAGE's package.json (`npm pkg set version=…`, see Dockerfile / auto-release.yml).
 *  Reading it back therefore means "this build was never stamped". */
export const UNSTAMPED_VERSION = '0.1.0'

/** Character class the collector accepts for version-shaped fields (validate.ts
 *  SAFE_VERSION). Enforced here too: a value that fails it is rejected field-by-field at
 *  ingest, which drops the WHOLE report — counts and signatures with it. */
const SAFE_VERSION = /^[A-Za-z0-9_.\-+]{1,32}$/

/** Short commit sha of the working tree, read straight from .git — no child process, no
 *  dependency, and nothing to run in a container (a released image ships no .git, and
 *  never reaches this path anyway because its package.json is stamped).
 *
 *  Returns null for anything unexpected rather than guessing. */
export function gitShortSha(root: string): string | null {
  const isSha = (s: string): boolean => /^[0-9a-f]{40}$/.test(s)
  const read = (...p: string[]): string | null => {
    try { return readFileSync(join(...p), 'utf-8').trim() } catch { return null }
  }
  try {
    // `.git` is a DIRECTORY in a normal clone but a FILE holding `gitdir: <path>` in a
    // worktree or submodule. Missing this returned a bare '0.0.0-dev' with no commit —
    // caught by running the built code rather than by a test, because the test supplied
    // the sha and only the file layout was wrong.
    const dotGit = join(root, '.git')
    const pointer = read(dotGit)
    const gitDir = pointer?.startsWith('gitdir: ') ? pointer.slice(8).trim() : dotGit

    const head = read(gitDir, 'HEAD')
    if (head === null) return null
    if (isSha(head)) return head.slice(0, 7) // detached HEAD holds the sha directly
    const ref = head.startsWith('ref: ') ? head.slice(5).trim() : null
    if (!ref) return null

    // A worktree keeps HEAD in its own gitdir but shares refs with the common dir, so
    // both are candidates. Loose ref first, then packed-refs (a freshly-cloned repo).
    const commonDir = read(gitDir, 'commondir')
    const dirs = [gitDir, ...(commonDir ? [join(gitDir, commonDir)] : [])]
    for (const d of dirs) {
      const loose = read(d, ref)
      if (loose !== null && isSha(loose)) return loose.slice(0, 7)
    }
    for (const d of dirs) {
      const packed = read(d, 'packed-refs')
      if (packed === null) continue
      for (const line of packed.split('\n')) {
        const [sha, name] = line.trim().split(' ')
        if (name === ref && isSha(sha)) return sha.slice(0, 7)
      }
    }
    return null
  } catch {
    return null
  }
}

/** What code is this node running? Pure — the caller supplies the readings.
 *
 *  Resolution order, most to least authoritative:
 *    1. ORQUESTRA_VERSION — an explicit operator/packager override.
 *    2. A STAMPED package.json — the released Docker image.
 *    3. `0.0.0-dev+<sha>` — an unstamped build, identified by its commit.
 *
 *  Case 3 is the fix. Unstamped builds used to report the literal `0.1.0`, which is a
 *  well-formed semver that was never released: in a per-version rollup it silently sorts
 *  as "some old release" and every source-run node in the fleet collapses into one
 *  indistinguishable bucket. Measured on the live collector — four of six installs
 *  reported `0.1.0`, so two thirds of the fleet could not be attributed to any code at
 *  all. `0.0.0-dev` cannot be mistaken for a release, and the sha says exactly which
 *  commit. (No new identification: installId is already a per-install UUID.)
 *
 *  Falls back rather than throwing — a version we cannot read is worth reporting as
 *  unknown, and is never worth failing a cycle over. */
export function resolveVersion(inputs: { override?: string; pkgVersion?: string; sha?: string | null }): string {
  const override = (inputs.override ?? '').trim()
  if (SAFE_VERSION.test(override)) return override
  const v = (inputs.pkgVersion ?? '').trim()
  if (v !== '' && v !== UNSTAMPED_VERSION) return SAFE_VERSION.test(v) ? v : 'unknown'
  return inputs.sha ? `0.0.0-dev+${inputs.sha}` : '0.0.0-dev'
}

/** File-system half of the above: locate the package root, read it, resolve. */
function orquestraVersion(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..') // dist/telemetry/ or src/telemetry/
    let pkgVersion: string | undefined
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version?: string }
      pkgVersion = typeof pkg.version === 'string' ? pkg.version : undefined
    } catch {
      // Unreadable package.json is not fatal — the override or the sha may still answer.
      pkgVersion = undefined
    }
    return resolveVersion({ override: env.ORQUESTRA_VERSION, pkgVersion, sha: gitShortSha(root) })
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
