// src/dashboard/health.ts
import type { ActivityEntry } from './activityLog.js'

export interface KindCounts { executed: number; refused: number; error: number }
export interface DatanetHealth {
  datanetId: string
  votes: KindCounts
  mints: KindCounts
  claims: KindCounts
  skips: number
  /** error codes across all kinds, desc by count. */
  topErrors: { code: string; count: number }[]
  /** most recent skip reason (the newest entry wins). */
  lastSkipReason?: string
}
export interface HealthReport { entriesScanned: number; datanets: DatanetHealth[] }

/** Extract the reppo CLI error code from an entry detail. The CLI embeds
 *  `{"error":{"code":"..."}}` inside a longer "Command failed: …" message, so a
 *  tolerant regex beats JSON.parse here. Unparseable → UNKNOWN. */
export function extractErrorCode(detail?: string): string {
  const m = detail?.match(/"code"\s*:\s*"([A-Za-z0-9_]+)"/)
  return m ? m[1] : 'UNKNOWN'
}

const counts = (): KindCounts => ({ executed: 0, refused: 0, error: 0 })

/** Aggregate activity (newest-first, as readActivity returns) into per-datanet
 *  health: vote/mint/claim outcome counts, skip count + latest reason, top errors. */
export function buildHealth(entries: ActivityEntry[]): HealthReport {
  const nets = new Map<string, DatanetHealth>()
  const errCounts = new Map<string, Map<string, number>>()
  const net = (id: string): DatanetHealth => {
    let n = nets.get(id)
    if (!n) { n = { datanetId: id, votes: counts(), mints: counts(), claims: counts(), skips: 0, topErrors: [] }; nets.set(id, n) }
    return n
  }
  for (const e of entries) {
    const n = net(e.datanetId)
    if (e.kind === 'skip') {
      n.skips++
      if (n.lastSkipReason === undefined) n.lastSkipReason = e.reason // first seen = newest
      continue
    }
    const bucket = e.kind === 'vote' ? n.votes : e.kind === 'mint' ? n.mints : n.claims
    if (e.status === 'executed') bucket.executed++
    else if (e.status === 'refused-budget') bucket.refused++
    else if (e.status === 'error') {
      bucket.error++
      const code = extractErrorCode(e.detail)
      const m = errCounts.get(e.datanetId) ?? new Map<string, number>()
      m.set(code, (m.get(code) ?? 0) + 1)
      errCounts.set(e.datanetId, m)
    }
  }
  for (const [id, m] of errCounts) {
    net(id).topErrors = [...m.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
  }
  return {
    entriesScanned: entries.length,
    datanets: [...nets.values()].sort((a, b) => a.datanetId.localeCompare(b.datanetId, undefined, { numeric: true })),
  }
}
