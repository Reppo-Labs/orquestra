// src/dashboard/activityLog.ts
import { appendFileSync, readFileSync, existsSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../util/redact.js'

export interface ActivityEntry {
  ts: string
  cycleId: string
  kind: 'vote' | 'mint' | 'claim' | 'skip'
  datanetId: string
  podId?: string
  direction?: 'up' | 'down'
  conviction?: number
  reason?: string
  canonicalKey?: string
  podName?: string
  epoch?: number
  reppoClaimed?: number
  status: 'executed' | 'refused-budget' | 'error' | 'skipped'
  txHash?: string
  gasEth?: number
  detail?: string
}

const FILE = 'activity-log.jsonl'
/** Rotate the log once it exceeds this. At a low cadence the file grows slowly,
 *  but it is otherwise unbounded — cap it so disk and parse cost stay finite.
 *  One generation of history is retained as `.jsonl.old`. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024 // 32 MiB ≈ hundreds of thousands of entries

function redactEntry(entry: ActivityEntry): ActivityEntry {
  return {
    ...entry,
    ...(entry.detail !== undefined ? { detail: redactSecrets(entry.detail) } : {}),
    ...(entry.reason !== undefined ? { reason: redactSecrets(entry.reason) } : {}),
  }
}

/** Append one entry as a single JSON line. Crash-safe: one line per action.
 *  detail/reason are redacted as defense-in-depth: error messages can carry CLI
 *  command lines (incl. --rpc-url keys) from paths that bypass the cli.ts fold.
 *  Rotates the file to `<file>.old` once it exceeds maxBytes (history retained). */
export function appendActivity(dataDir: string, entry: ActivityEntry, opts: { maxBytes?: number } = {}): void {
  const path = join(dataDir, FILE)
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  if (existsSync(path) && statSync(path).size > maxBytes) {
    renameSync(path, path + '.old') // single generation; next rotation overwrites it
  }
  appendFileSync(path, JSON.stringify(redactEntry(entry)) + '\n')
}

// Parse cache keyed by file path: the dashboard polls /api/pnl + /api/health every
// 30s and each re-parsed the whole (ever-growing) JSONL. The file is append-only,
// so (size, mtime) identity means the parsed entries are still valid.
const parseCache = new Map<string, { size: number; mtimeMs: number; entries: ActivityEntry[] }>()

/** Read the most recent `limit` entries, newest-first. Skips unparseable lines
 *  (e.g. a torn final line from a crash). Missing file → []. Repeat reads of an
 *  unchanged file are served from an in-process cache. */
export function readActivity(dataDir: string, opts: { limit: number }): ActivityEntry[] {
  const path = join(dataDir, FILE)
  if (!existsSync(path)) return []
  const st = statSync(path)
  const hit = parseCache.get(path)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.entries.slice(0, opts.limit)
  const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim() !== '')
  const out: ActivityEntry[] = []
  for (const line of lines) {
    // Redact on read too: lines appended before redaction existed (or by a future
    // path that forgets) are sanitized before they reach the dashboard.
    try { out.push(redactEntry(JSON.parse(line) as ActivityEntry)) } catch { /* skip torn/invalid line */ }
  }
  out.reverse()
  parseCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, entries: out })
  return out.slice(0, opts.limit)
}
