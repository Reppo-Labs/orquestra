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
  /** true when the datanet's NEWEST entry is a skip — i.e. it is idle right now.
   *  A skip followed by later activity is history, not current idleness. */
  idle: boolean
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

export interface HealthOpts {
  /** epoch ms; entries with ts older than this are excluded. Keeps the panel a
   *  RECENT-health view — at low cadences a fixed entry count spans hours, at
   *  high cadences months, so the window is time-based, not count-based. */
  sinceMs?: number
}

/** Aggregate activity (newest-first, as readActivity returns) into per-datanet
 *  health: vote/mint/claim outcome counts, skip count + latest reason, top errors. */
export function buildHealth(entries: ActivityEntry[], opts: HealthOpts = {}): HealthReport {
  if (opts.sinceMs !== undefined) {
    const since = opts.sinceMs
    entries = entries.filter((e) => {
      const t = Date.parse(e.ts)
      return Number.isNaN(t) || t >= since // unparseable ts stays in (tolerant-read style)
    })
  }
  const nets = new Map<string, DatanetHealth>()
  const errCounts = new Map<string, Map<string, number>>()
  const net = (id: string): DatanetHealth => {
    let n = nets.get(id)
    if (!n) { n = { datanetId: id, votes: counts(), mints: counts(), claims: counts(), skips: 0, topErrors: [], idle: false }; nets.set(id, n) }
    return n
  }
  const seen = new Set<string>()
  for (const e of entries) {
    const n = net(e.datanetId)
    // entries are newest-first: the first entry seen per datanet is its current state.
    if (!seen.has(e.datanetId)) { seen.add(e.datanetId); n.idle = e.kind === 'skip' }
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
