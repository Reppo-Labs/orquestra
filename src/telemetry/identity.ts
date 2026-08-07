// src/telemetry/identity.ts — the anonymous install identifier.
//
// A random UUID minted on first use and persisted in DATA_DIR. It is deliberately NOT
// derived from anything: not the wallet address, not the hostname, not the MAC, not the
// data dir path. Two nodes on one machine with different DATA_DIRs are unrelated ids, and
// no id can be computed from another (specs/telemetry-consent).
//
// Why not hash the wallet address instead: the set of node wallet addresses is small and
// fully enumerable from public chain data, so any hash of one is reversible by brute force
// over that set. A derived id would be pseudonymous in name only.
//
// Stored as a plain JSON file rather than a row in activity.db so the identifier survives
// a DB reset, and so an operator can read it with `cat` — this is a transparency feature,
// and state an operator cannot inspect undermines the point of it.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const FILE = 'telemetry-identity.json'

interface Identity {
  installId: string
}

/** Absolute path of the identity file inside the data dir. */
export function identityPath(dataDir: string): string {
  return join(dataDir, FILE)
}

function isIdentity(v: unknown): v is Identity {
  const o = v as Record<string, unknown> | null
  return !!o && typeof o.installId === 'string' && o.installId !== ''
}

/** Read the persisted install id; null when absent or corrupt. */
function read(dataDir: string): string | null {
  const path = identityPath(dataDir)
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return isIdentity(parsed) ? parsed.installId : null
  } catch {
    return null
  }
}

/** Persist atomically (temp file + rename) so a crash mid-write cannot leave torn JSON —
 *  a torn read looks like "no identity", which would silently mint a second id and split
 *  one install into two in the collector's distinct-install counts. */
function write(dataDir: string, installId: string): void {
  const path = identityPath(dataDir)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ installId } satisfies Identity, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}

/** The install id for this data dir, minting and persisting one on first call.
 *  Stable across restarts; a corrupt file is replaced rather than reused. */
export function getInstallId(dataDir: string): string {
  const existing = read(dataDir)
  if (existing) return existing
  const minted = randomUUID()
  write(dataDir, minted)
  return minted
}
