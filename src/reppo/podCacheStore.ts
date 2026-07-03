// src/reppo/podCacheStore.ts
// DB-backed PodCache for the on-chain emissions scanner: the set of pod NFTs our wallet
// owns (enumerated from Transfer logs) + the last block scanned, so each cycle reads
// only new logs. Lives in the shared activity.db (emit_pods / emit_scan tables).
import { getDb } from '../dashboard/db.js'
import type { PodCache, EpochScanCache } from './emissionsOnchain.js'

export function makeDbPodCache(dataDir: string): PodCache {
  const db = getDb(dataDir)
  return {
    getKnownPods(): string[] {
      return (db.prepare('SELECT podId FROM emit_pods').all() as { podId: string }[]).map((r) => r.podId)
    },
    addPods(ids: string[]): void {
      const ins = db.prepare('INSERT OR IGNORE INTO emit_pods (podId) VALUES (?)')
      for (const id of ids) ins.run(id)
    },
    getLastBlock(): bigint | null {
      const row = db.prepare('SELECT lastBlock FROM emit_scan WHERE id = 1').get() as { lastBlock: string } | undefined
      return row ? BigInt(row.lastBlock) : null
    },
    setLastBlock(b: bigint): void {
      db.prepare('INSERT INTO emit_scan (id, lastBlock) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET lastBlock = excluded.lastBlock')
        .run(b.toString())
    },
  }
}

/** DB-backed per-pod scan watermark: the highest CLOSED epoch already scanned for each
 *  pod (so a first run deep-scans all history once, then steady-state checks only new epochs). */
function makeScanCache(dataDir: string, table: 'voter_scan' | 'owner_scan'): EpochScanCache {
  const db = getDb(dataDir)
  return {
    getThrough(podId: string): number {
      const row = db.prepare(`SELECT throughEpoch FROM ${table} WHERE podId = ?`).get(podId) as { throughEpoch: number } | undefined
      return row ? row.throughEpoch : 0
    },
    setThrough(podId: string, epoch: number): void {
      db.prepare(`INSERT INTO ${table} (podId, throughEpoch) VALUES (?, ?) ON CONFLICT(podId) DO UPDATE SET throughEpoch = excluded.throughEpoch`)
        .run(podId, epoch)
    },
  }
}

/** Watermark for the VOTER-emissions scan (pods the wallet voted on). */
export function makeVoterScanCache(dataDir: string): EpochScanCache {
  return makeScanCache(dataDir, 'voter_scan')
}

/** Watermark for the OWNER-emissions scan (pods the wallet owns). Backfills history on
 *  first run so claimable epochs older than the old 3-epoch window are found. */
export function makeOwnerScanCache(dataDir: string): EpochScanCache {
  return makeScanCache(dataDir, 'owner_scan')
}
