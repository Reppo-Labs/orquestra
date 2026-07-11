// src/learn/econ.ts
// Economics half of the learn loop: attribute each executed activity row to a
// (datanet, epoch) bucket. Claims carry no datanetId (PodManager claims are keyed
// pod+epoch only), so attribution goes through data the node already has:
//   owner claims  → the datanet whose own-pod set contains the claimed podId
//   voter claims  → the datanet of OUR vote row for that podId (voter claims pay
//                   for votes on OTHERS' pods)
//   unattributable → datanetId '' (kept visible in totals, never silently dropped)
// Mint/vote rows carry datanetId but no epoch → bucketed to the CURRENT epoch at
// collect time. Buckets are ADDITIVE; the activity-id watermark guarantees each row
// is counted exactly once across cycles.
import type { ActivityEntry } from '../dashboard/activityLog.js'
import { getDb } from '../dashboard/db.js'
import { addEconDeltas, getEconWatermark, setEconWatermark, type EconEpochRow } from './store.js'

function emptyBucket(datanetId: string, epoch: number): EconEpochRow {
  return { datanetId, epoch, ownerClaimedReppo: 0, voterClaimedReppo: 0, mintCostReppo: 0, mintCount: 0, votesCast: 0 }
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
  currentEpoch: number,
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
      const epoch = row.epoch ?? currentEpoch
      const isVoterClaim = (row.detail ?? '').includes('voter')
      if (isVoterClaim) {
        const datanetId = voteDatanetByPodId.get(row.podId ?? '') ?? ''
        bucketFor(datanetId, epoch).voterClaimedReppo += row.reppoClaimed ?? 0
      } else {
        const datanetId = ownerDatanetFor(row.podId, ownPodIdsByDatanet)
        bucketFor(datanetId, epoch).ownerClaimedReppo += row.reppoClaimed ?? 0
      }
    } else if (row.kind === 'mint') {
      const b = bucketFor(row.datanetId, currentEpoch)
      b.mintCostReppo += row.reppoSpent ?? 0
      b.mintCount += 1
    } else if (row.kind === 'vote') {
      bucketFor(row.datanetId, currentEpoch).votesCast += 1
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
  currentEpoch: number,
): number {
  const d = getDb(dataDir)
  const watermark = getEconWatermark(dataDir)

  const raw = d.prepare(
    `SELECT id, ts, cycleId, kind, datanetId, podId, epoch, reppoClaimed, reppoSpent, detail, status
     FROM activity WHERE id > ? AND status = 'executed' AND kind IN ('claim', 'mint', 'vote') ORDER BY id`,
  ).all(watermark) as unknown as RawEconActivityRow[]
  if (raw.length === 0) return 0

  // Full history — voter claims can arrive many epochs after the vote that earned them.
  const voteRows = d.prepare(
    "SELECT DISTINCT podId, datanetId FROM activity WHERE kind = 'vote' AND podId IS NOT NULL",
  ).all() as unknown as { podId: string; datanetId: string }[]
  const voteDatanetByPodId = new Map(voteRows.map((r) => [r.podId, r.datanetId]))

  const entries = raw.map(toEntry)
  const buckets = bucketEconomics(entries, ownPodIdsByDatanet, voteDatanetByPodId, currentEpoch)
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
