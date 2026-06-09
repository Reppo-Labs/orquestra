// src/dashboard/activityLog.ts
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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

/** Append one entry as a single JSON line. Crash-safe: one line per action. */
export function appendActivity(dataDir: string, entry: ActivityEntry): void {
  appendFileSync(join(dataDir, FILE), JSON.stringify(entry) + '\n')
}

/** Read the most recent `limit` entries, newest-first. Skips unparseable lines
 *  (e.g. a torn final line from a crash). Missing file → []. */
export function readActivity(dataDir: string, opts: { limit: number }): ActivityEntry[] {
  const path = join(dataDir, FILE)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim() !== '')
  const out: ActivityEntry[] = []
  for (const line of lines) {
    try { out.push(JSON.parse(line) as ActivityEntry) } catch { /* skip torn/invalid line */ }
  }
  return out.reverse().slice(0, opts.limit)
}
