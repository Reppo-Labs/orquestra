// src/dashboard/backfill.ts
// One-time migration: synthesize historical activity-log entries from prior state
// that predates the activity log. These rows carry NO txHash/direction/real timestamp
// (the old code never captured them) — they are tagged 'backfill' and clearly labeled.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { appendActivity, readActivity, type ActivityEntry } from './activityLog.js'
import type { VoterPod } from '../voter/types.js'

const BACKFILL_CYCLE = 'backfill'

/** Pure: build vote entries from the dedup state's votedPodIds and mint entries from
 *  the wallet's on-chain own pods (per datanet). `ts` stamps every row identically. */
export function buildBackfillEntries(
  votedPodIds: Record<string, string[]>,
  ownPodsByDatanet: Record<string, VoterPod[]>,
  ts: string,
): ActivityEntry[] {
  const entries: ActivityEntry[] = []
  for (const [datanetId, podIds] of Object.entries(votedPodIds)) {
    for (const podId of podIds) {
      entries.push({
        ts, cycleId: BACKFILL_CYCLE, kind: 'vote', datanetId, podId,
        status: 'executed', detail: 'backfilled — pre-dashboard history (no tx/direction)',
      })
    }
  }
  for (const [datanetId, pods] of Object.entries(ownPodsByDatanet)) {
    for (const p of pods) {
      const epoch = Number(p.validityEpoch)
      entries.push({
        ts, cycleId: BACKFILL_CYCLE, kind: 'mint', datanetId,
        canonicalKey: p.podId, podName: p.name, epoch: Number.isFinite(epoch) ? epoch : undefined,
        status: 'executed', detail: 'backfilled — pre-dashboard history (no tx)',
      })
    }
  }
  return entries
}

export interface BackfillResult { votes: number; mints: number; skipped: boolean }

/** Read the dedup state + (best-effort) on-chain own pods, then append backfill rows
 *  to the activity log. Idempotent: if a backfill has already run, does nothing. */
export async function backfillActivityLog(
  dataDir: string,
  datanetIds: string[],
  listOwnPods: (datanetId: string) => Promise<VoterPod[]>,
  ts: string,
): Promise<BackfillResult> {
  // Idempotency: don't double-backfill if a prior run already wrote backfill rows.
  if (readActivity(dataDir, { limit: 100000 }).some((e) => e.cycleId === BACKFILL_CYCLE)) {
    return { votes: 0, mints: 0, skipped: true }
  }

  const statePath = join(dataDir, 'vote-state.json')
  let votedPodIds: Record<string, string[]> = {}
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as { votedPodIds?: Record<string, string[]> }
      votedPodIds = parsed.votedPodIds ?? {}
    } catch (e) {
      console.error(`orquestra: backfill could not read vote-state.json: ${(e as Error).message}`)
    }
  }

  // Mints come from on-chain own pods. Per-datanet isolation: a failing query for one
  // datanet skips it, never the whole backfill.
  const ownPodsByDatanet: Record<string, VoterPod[]> = {}
  for (const id of datanetIds) {
    try {
      const pods = await listOwnPods(id)
      if (pods.length > 0) ownPodsByDatanet[id] = pods
    } catch (e) {
      console.error(`orquestra: backfill own-pods query failed for datanet ${id}, skipped — ${(e as Error).message}`)
    }
  }

  const entries = buildBackfillEntries(votedPodIds, ownPodsByDatanet, ts)
  for (const entry of entries) appendActivity(dataDir, entry)
  const votes = entries.filter((e) => e.kind === 'vote').length
  const mints = entries.filter((e) => e.kind === 'mint').length
  return { votes, mints, skipped: false }
}
