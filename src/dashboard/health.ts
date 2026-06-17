// src/dashboard/health.ts
import type { ActivityEntry } from './activityLog.js'

export interface KindCounts { executed: number; refused: number; error: number }
/** On-chain attempt outcome: executed vs error. Budget refusals are NOT failures —
 *  no tx was attempted — so they are excluded from the rate. */
export interface TxRate { executed: number; failed: number; rate: number | null }
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
  /** executed vs failed tx attempts across vote+mint+claim (refused excluded). */
  txRate: TxRate
}
export interface HealthReport { entriesScanned: number; datanets: DatanetHealth[]; txRate: TxRate }

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
    if (!n) { n = { datanetId: id, votes: counts(), mints: counts(), claims: counts(), skips: 0, topErrors: [], idle: false, txRate: { executed: 0, failed: 0, rate: null } }; nets.set(id, n) }
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
    // 'grant' is a one-time access-grant breadcrumb (setup), not a tx outcome we rate
    // and not a skip — exclude it from the vote/mint/claim buckets, the skip count, AND
    // the txRate (it would otherwise be miscounted as a claim by the else branch below).
    // 'stake' (a veREPPO top-up breadcrumb) is treated the same way — also setup, not a
    // vote/mint/claim outcome.
    if (e.kind === 'grant' || e.kind === 'stake') continue
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
  const finalize = (executed: number, failed: number): TxRate =>
    ({ executed, failed, rate: executed + failed > 0 ? executed / (executed + failed) : null })
  // Pre-broadcast rejections (no tx ever attempted) are not tx failures — they stay
  // in the error counts and topErrors for visibility, but don't poison the rate.
  const PRE_BROADCAST = new Set(['CANNOT_VOTE_FOR_OWN_POD'])
  let allExecuted = 0, allFailed = 0
  for (const n of nets.values()) {
    const executed = n.votes.executed + n.mints.executed + n.claims.executed
    const errors = n.votes.error + n.mints.error + n.claims.error
    let preBroadcast = 0
    for (const code of PRE_BROADCAST) preBroadcast += errCounts.get(n.datanetId)?.get(code) ?? 0
    const failed = errors - preBroadcast
    n.txRate = finalize(executed, failed)
    allExecuted += executed; allFailed += failed
  }
  return {
    entriesScanned: entries.length,
    datanets: [...nets.values()].sort((a, b) => a.datanetId.localeCompare(b.datanetId, undefined, { numeric: true })),
    txRate: finalize(allExecuted, allFailed),
  }
}
