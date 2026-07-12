// src/learn/econ.ts
// Economics half of the learn loop: attribute each executed activity row to a
// (datanet, epoch) bucket. Claims carry no datanetId (PodManager claims are keyed
// pod+epoch only), so attribution goes through data the node already has:
//   owner claims  → the datanet whose own-pod set contains the claimed podId
//   voter claims  → the datanet of OUR vote row for that podId (voter claims pay
//                   for votes on OTHERS' pods)
//   unattributable → datanetId '' (kept visible in totals, never silently dropped)
// Mint/vote rows carry datanetId but no epoch → their epoch is derived from the
// row's own ts against the current epoch window (epochAt), so a backlog collected
// late still lands in the epoch the action actually happened in. Buckets are
// ADDITIVE; the activity-id watermark guarantees each row is counted exactly once
// across cycles.
import type { ActivityEntry } from '../dashboard/activityLog.js'
import { getDb } from '../dashboard/db.js'
import { addEconDeltas, getEconWatermark, setEconWatermark, type EconEpochRow } from './store.js'

/** Subset of src/reppo/queryEpoch.ts EpochInfo the collector needs to place a
 *  timestamp in an epoch. epochStart is unix SECONDS. */
export interface EconEpochInfo {
  epoch: number
  epochStart: number
  epochDurationSeconds: number
}

/** Discriminator for voter-claim activity rows. cycle.ts writes claim details as
 *  'voter · …' / 'voter emissions' for voter claims; owner-claim details never
 *  contain it. This couples us to that free text — keep the two in sync. */
export const VOTER_CLAIM_DETAIL = 'voter'

function emptyBucket(datanetId: string, epoch: number): EconEpochRow {
  return { datanetId, epoch, ownerClaimedReppo: 0, voterClaimedReppo: 0, mintCostReppo: 0, mintCount: 0, votesCast: 0 }
}

/** Epoch a wall-clock timestamp fell in, derived from the CURRENT epoch's start.
 *  ts within the current epoch → epoch; older → walk back whole durations. Falls
 *  back to the current epoch when duration is 0/invalid (never NaN buckets). */
function epochAt(tsIso: string, e: EconEpochInfo): number {
  const ts = Date.parse(tsIso) / 1000
  if (!Number.isFinite(ts) || e.epochDurationSeconds <= 0) return e.epoch
  if (ts >= e.epochStart) return e.epoch
  const back = Math.ceil((e.epochStart - ts) / e.epochDurationSeconds)
  return Math.max(0, e.epoch - back)
}

/** Which of ownPodIdsByDatanet's sets contains podId, or '' when none does (or podId
 *  is absent). Iteration order over the Map decides the tie-break on the (should-not-
 *  happen) case where a podId appears in more than one datanet's own-pod set. */
function ownerDatanetFor(podId: string | undefined, ownPodIdsByDatanet: Map<string, Set<string>>): string {
  if (!podId) return ''
  for (const [datanetId, pods] of ownPodIdsByDatanet) {
    if (pods.has(podId)) return datanetId
  }
  return ''
}

/** PURE. Bucket executed activity rows into per-(datanet, epoch) REPPO economics. */
export function bucketEconomics(
  rows: (ActivityEntry & { id?: number })[],
  ownPodIdsByDatanet: Map<string, Set<string>>,
  voteDatanetByPodId: Map<string, string>,
  epochInfo: EconEpochInfo,
): EconEpochRow[] {
  const buckets = new Map<string, EconEpochRow>()
  const bucketFor = (datanetId: string, epoch: number): EconEpochRow => {
    const key = `${datanetId} ${epoch}`
    let b = buckets.get(key)
    if (!b) {
      b = emptyBucket(datanetId, epoch)
      buckets.set(key, b)
    }
    return b
  }

  for (const row of rows) {
    if (row.status !== 'executed') continue

    if (row.kind === 'claim') {
      // Claims are per (pod, epoch) — trust the row's own epoch; ts-derived fallback
      // only when a claim row somehow lacks one.
      const epoch = row.epoch ?? epochAt(row.ts, epochInfo)
      const isVoterClaim = (row.detail ?? '').includes(VOTER_CLAIM_DETAIL)
      if (isVoterClaim) {
        const datanetId = voteDatanetByPodId.get(row.podId ?? '') ?? ''
        bucketFor(datanetId, epoch).voterClaimedReppo += row.reppoClaimed ?? 0
      } else {
        const datanetId = ownerDatanetFor(row.podId, ownPodIdsByDatanet)
        bucketFor(datanetId, epoch).ownerClaimedReppo += row.reppoClaimed ?? 0
      }
    } else if (row.kind === 'mint') {
      const b = bucketFor(row.datanetId, epochAt(row.ts, epochInfo))
      b.mintCostReppo += row.reppoSpent ?? 0
      b.mintCount += 1
    } else if (row.kind === 'vote') {
      bucketFor(row.datanetId, epochAt(row.ts, epochInfo)).votesCast += 1
    }
    // other kinds ('skip', 'grant', 'stake', 'info') carry no economics — ignored.
  }

  return [...buckets.values()]
}

interface RawEconActivityRow {
  id: number
  ts: string | null
  cycleId: string | null
  kind: string | null
  datanetId: string | null
  podId: string | null
  epoch: number | null
  reppoClaimed: number | null
  reppoSpent: number | null
  detail: string | null
  status: string | null
}

function toEntry(r: RawEconActivityRow): ActivityEntry & { id: number } {
  return {
    id: r.id,
    ts: r.ts ?? '',
    cycleId: r.cycleId ?? '',
    // The casts on kind/status are safe because the SQL WHERE clause is the enforcing
    // filter (status='executed' AND kind IN ('claim','mint','vote')) — only rows
    // already matching the union values reach this mapping.
    kind: (r.kind ?? '') as ActivityEntry['kind'],
    datanetId: r.datanetId ?? '',
    podId: r.podId ?? undefined,
    epoch: r.epoch ?? undefined,
    reppoClaimed: r.reppoClaimed ?? undefined,
    reppoSpent: r.reppoSpent ?? undefined,
    detail: r.detail ?? undefined,
    status: (r.status ?? 'executed') as ActivityEntry['status'],
  }
}

/** IO orchestrator: process activity rows with id > watermark, add buckets, advance
 *  the watermark. voteDatanetByPodId is built with one SQL query over vote rows.
 *  Returns the number of rows processed. Never throws into the caller's cycle —
 *  callers wrap; this function itself may throw on DB errors. */
export function collectEconomics(
  dataDir: string,
  ownPodIdsByDatanet: Map<string, Set<string>>,
  epochInfo: EconEpochInfo,
): number {
  const d = getDb(dataDir)
  const watermark = getEconWatermark(dataDir)

  const raw = d.prepare(
    `SELECT id, ts, cycleId, kind, datanetId, podId, epoch, reppoClaimed, reppoSpent, detail, status
     FROM activity WHERE id > ? AND status = 'executed' AND kind IN ('claim', 'mint', 'vote') ORDER BY id`,
  ).all(watermark) as unknown as RawEconActivityRow[]
  if (raw.length === 0) return 0

  // Full history — voter claims can arrive many epochs after the vote that earned them.
  // ORDER BY id + Map insertion ⇒ the LAST vote row for a pod wins (a re-vote's datanet
  // supersedes older rows; in practice a pod belongs to one datanet, so ties are moot).
  const voteRows = d.prepare(
    "SELECT podId, datanetId FROM activity WHERE kind = 'vote' AND podId IS NOT NULL ORDER BY id",
  ).all() as unknown as { podId: string; datanetId: string }[]
  const voteDatanetByPodId = new Map(voteRows.map((r) => [r.podId, r.datanetId]))

  const entries = raw.map(toEntry)
  const buckets = bucketEconomics(entries, ownPodIdsByDatanet, voteDatanetByPodId, epochInfo)
  const lastId = raw[raw.length - 1].id

  d.exec('BEGIN')
  try {
    addEconDeltas(dataDir, buckets)
    setEconWatermark(dataDir, lastId)
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }

  return raw.length
}
