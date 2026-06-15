// src/runtime/state.ts
import { readFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, type SqliteDb } from '../dashboard/db.js'

// Dedup rows live in the shared `dedup` table (kind, datanetId, key), owned by db.ts.
//
// claimedKeys is a FLAT `${podId}:${epoch}` set, NOT datanet-scoped: emissions are
// claimed on-chain by (pod, epoch) alone (the CLI takes only --pod --epoch), and a pod
// belongs to exactly one datanet, so the datanet dimension is redundant and would risk
// a re-claim if the CLI's datanetId ever shifted between versions.
// grantedSubnets is a FLAT set used as the subnet-access grant cache. NOTE: despite the
// name it holds the INTEGER datanet id (grant-access is keyed by `--datanet <id>`, see
// cycle.ts), NOT the subnet UUID. A subnet maps 1:1 to a datanet, so the id is a valid
// stable key; the field name is historical. Prevents re-granting (a one-time on-chain
// setup) every cycle. Both flat sets use the sentinel datanetId '' below.
interface Shape { votedPodIds: Record<string, string[]>; mintedKeys: Record<string, string[]>; claimedKeys: string[]; grantedSubnets: string[] }
const LEGACY = 'vote-state.json'
const FLAT = '' // datanetId sentinel for wallet-global (claim / grant) sets

/** Persisted dedup state: which pods we've voted on + which dataset keys we've
 *  minted, per datanet. Prevents re-voting (gas/power waste) + re-minting. */
export class DedupState {
  private readonly db: SqliteDb
  constructor(private readonly dataDir: string) {
    this.db = getDb(dataDir)
    this.importLegacy()
  }

  /** One-time import of a pre-existing vote-state.json into the empty table, then
   *  rename it *.imported. A corrupt file imports nothing (start empty — worst case a
   *  re-vote attempt, which the chain dedups by epoch), still renamed so we don't retry. */
  private importLegacy(): void {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM dedup').get() as { n: number }).n
    if (n > 0) return
    const path = join(this.dataDir, LEGACY)
    if (!existsSync(path)) return
    let parsed: Partial<Shape> | null = null
    try { parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Shape> } catch { parsed = null }
    if (parsed) {
      const ins = this.db.prepare('INSERT OR IGNORE INTO dedup (kind, datanetId, key) VALUES (?, ?, ?)')
      this.db.exec('BEGIN')
      try {
        for (const [dn, ids] of Object.entries(parsed.votedPodIds ?? {})) for (const id of ids) ins.run('vote', dn, id)
        for (const [dn, keys] of Object.entries(parsed.mintedKeys ?? {})) for (const k of keys) ins.run('mint', dn, k)
        for (const k of Array.isArray(parsed.claimedKeys) ? parsed.claimedKeys : []) ins.run('claim', FLAT, k)
        for (const s of Array.isArray(parsed.grantedSubnets) ? parsed.grantedSubnets : []) ins.run('grant', FLAT, s)
        this.db.exec('COMMIT')
      } catch (e) { this.db.exec('ROLLBACK'); throw e }
    }
    renameSync(path, path + '.imported')
  }

  getVotedPodIds(datanetId: string): string[] { return this.keys('vote', datanetId) }
  getMintedKeys(datanetId: string): string[] { return this.keys('mint', datanetId) }
  recordVote(datanetId: string, podId: string): void { this.put('vote', datanetId, podId) }
  recordMint(datanetId: string, key: string): void { this.put('mint', datanetId, key) }
  /** Flat (podId:epoch) claim set — see note on Shape; not datanet-scoped. */
  getClaimedKeys(): string[] { return this.keys('claim', FLAT) }
  /** Flat set of datanet ids whose subnet access the wallet already has (grant cache
   *  key; see the note on Shape — the name is historical, the values are datanet ids). */
  getGrantedSubnets(): string[] { return this.keys('grant', FLAT) }
  recordClaim(key: string): void { this.put('claim', FLAT, key) }
  recordGrant(subnetId: string): void { this.put('grant', FLAT, subnetId) }
  /** Evict a stale grant-cache entry (on-chain access disagreed with the cache). */
  removeGrant(subnetId: string): void {
    try {
      this.db.prepare('DELETE FROM dedup WHERE kind = ? AND datanetId = ? AND key = ?').run('grant', FLAT, subnetId)
    } catch (e) {
      console.error(`orquestra: failed to persist dedup state: ${(e as Error).message}`)
    }
  }

  private keys(kind: string, datanetId: string): string[] {
    const rows = this.db.prepare('SELECT key FROM dedup WHERE kind = ? AND datanetId = ?').all(kind, datanetId) as { key: string }[]
    return rows.map((r) => r.key)
  }

  /** INSERT OR IGNORE — the PRIMARY KEY (kind, datanetId, key) makes this idempotent.
   *  Best-effort: never throw into the caller (a throw would crash the cycle and orphan
   *  a just-landed on-chain action; the chain dedups by epoch as the backstop). */
  private put(kind: string, datanetId: string, key: string): void {
    try {
      this.db.prepare('INSERT OR IGNORE INTO dedup (kind, datanetId, key) VALUES (?, ?, ?)').run(kind, datanetId, key)
    } catch (e) {
      console.error(`orquestra: failed to persist dedup state: ${(e as Error).message}`)
    }
  }
}
