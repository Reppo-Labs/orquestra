// src/dashboard/activityLog.ts
import { appendFileSync, readFileSync, existsSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../util/redact.js'
import type { PanelTranscript } from '../panel/types.js'

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
  /** multi-agent panel transcript when a panel produced this vote/mint (see src/panel). */
  panel?: PanelTranscript
}

const FILE = 'activity-log.jsonl'
/** Rotate the log once it exceeds this. At a low cadence the file grows slowly,
 *  but it is otherwise unbounded — cap it so disk and parse cost stay finite.
 *  ONE generation of history is retained as `.jsonl.old`; readActivity spans
 *  live + `.old`. Caveat: cumulative metrics derived from the full log
 *  (pnl.ts/earnStatus.ts "claimed to date") only see live + one archive, so
 *  after a SECOND rotation the oldest realized claims roll off. At 32 MiB/gen
 *  (≈ hundreds of thousands of entries) that is years away at any real cadence;
 *  authoritative cumulative accounting should come from on-chain/ledger state. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

function redactEntry(entry: ActivityEntry): ActivityEntry {
  return {
    ...entry,
    ...(entry.detail !== undefined ? { detail: redactSecrets(entry.detail) } : {}),
    ...(entry.reason !== undefined ? { reason: redactSecrets(entry.reason) } : {}),
    // Panel transcript text is LLM-generated from untrusted pod data and may echo
    // the operator brief — redact the same way as detail/reason before it is
    // persisted and before /api/activity serves it to the dashboard.
    ...(entry.panel !== undefined ? {
      panel: {
        ...entry.panel,
        panelists: entry.panel.panelists.map((p) => ({ ...p, argument: redactSecrets(p.argument) })),
        judge: { ...entry.panel.judge, reason: redactSecrets(entry.panel.judge.reason) },
      },
    } : {}),
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
const parseCache = new Map<string, { key: string; entries: ActivityEntry[] }>()

function parseLines(text: string): ActivityEntry[] {
  const out: ActivityEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    // Redact on read too: lines appended before redaction existed (or by a future
    // path that forgets) are sanitized before they reach the dashboard.
    try { out.push(redactEntry(JSON.parse(line) as ActivityEntry)) } catch { /* skip torn/invalid line */ }
  }
  return out
}

/** Read the most recent `limit` entries, newest-first. Skips unparseable lines
 *  (e.g. a torn final line from a crash). Missing file → []. Includes one rotated
 *  generation (`.old`) so consumers (earn attribution) survive a rotation. Repeat
 *  reads of an unchanged live file are served from an in-process cache. */
export function readActivity(dataDir: string, opts: { limit: number }): ActivityEntry[] {
  const path = join(dataDir, FILE)
  if (!existsSync(path)) return []
  const st = statSync(path)
  const oldPath = path + '.old'
  const oldSt = existsSync(oldPath) ? statSync(oldPath) : null
  const cacheKey = `${st.size}:${st.mtimeMs}:${oldSt ? `${oldSt.size}:${oldSt.mtimeMs}` : '0'}`
  const hit = parseCache.get(path)
  if (hit && hit.key === cacheKey) return hit.entries.slice(0, opts.limit)
  // newest-first overall: live file (newer) reversed first, then the rotated file.
  const live = parseLines(readFileSync(path, 'utf-8')).reverse()
  const archived = oldSt ? parseLines(readFileSync(oldPath, 'utf-8')).reverse() : []
  const out = [...live, ...archived]
  parseCache.set(path, { key: cacheKey, entries: out })
  return out.slice(0, opts.limit)
}
