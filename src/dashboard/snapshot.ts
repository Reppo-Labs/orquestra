// src/dashboard/snapshot.ts
import { readFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, type SqliteDb } from './db.js'
import type { WalletBalance } from '../reppo/queryBalance.js'
import type { VotingPower } from '../reppo/queryVotingPower.js'
import type { EmissionsDue } from '../reppo/queryEmissionsDue.js'
import type { EpochInfo } from '../reppo/queryEpoch.js'
import type { BudgetCaps } from '../wallet/ledger.js'
import type { LlmUsageSnapshot } from '../llm/usage.js'

export interface SnapshotBudget {
  mintReppoSpent: number
  mintGasSpentEth: number
  voteGasSpentEth: number
  claimGasSpentEth: number
  caps: BudgetCaps
}
export interface Snapshot {
  ts: string
  cycleId: string
  balance: WalletBalance
  votingPower: VotingPower
  emissionsDue: EmissionsDue
  budget: SnapshotBudget
  /** authoritative current on-chain epoch (reppo >=0.8.0); optional for back-compat. */
  epoch?: EpochInfo
  /** LLM token usage + estimated USD cost for THIS cycle (all calls in the cycle window).
   *  Optional for back-compat with pre-feature rows. estCostUsd null = no priceable model. */
  llm?: LlmUsageSnapshot
}

const LEGACY = 'snapshot.json'

// The `snapshot` table is owned by db.ts; one row per cycle (history), read-latest.
const snapImported = new Set<string>()
function conn(dataDir: string): SqliteDb {
  const d = getDb(dataDir)
  if (!snapImported.has(dataDir)) {
    importLegacySnapshot(d, dataDir)
    snapImported.add(dataDir)
  }
  return d
}

/** One-time import of a pre-existing snapshot.json into an empty table, then rename
 *  it to *.imported. No-op once the table has rows. */
function importLegacySnapshot(d: SqliteDb, dataDir: string): void {
  const count = (d.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n
  if (count > 0) return
  const live = join(dataDir, LEGACY)
  if (!existsSync(live)) return
  try {
    const snap = JSON.parse(readFileSync(live, 'utf-8')) as Snapshot
    d.prepare('INSERT INTO snapshot (ts, cycleId, data) VALUES (?, ?, ?)')
      .run(snap.ts ?? new Date().toISOString(), snap.cycleId ?? null, JSON.stringify(snap))
  } catch { /* corrupt legacy file — skip the import, still rename so we don't retry */ }
  renameSync(live, live + '.imported')
}

export function writeSnapshot(dataDir: string, snap: Snapshot): void {
  conn(dataDir).prepare('INSERT INTO snapshot (ts, cycleId, data) VALUES (?, ?, ?)')
    .run(snap.ts, snap.cycleId ?? null, JSON.stringify(snap))
}

export function readSnapshot(dataDir: string): Snapshot | null {
  const row = conn(dataDir).prepare('SELECT data FROM snapshot ORDER BY id DESC LIMIT 1').get() as
    | { data: string }
    | undefined
  if (!row) return null
  try { return JSON.parse(row.data) as Snapshot } catch { return null }
}

export interface SnapshotReaders {
  balance(): Promise<WalletBalance>
  votingPower(): Promise<VotingPower>
  emissionsDue(): Promise<EmissionsDue>
  epoch(): Promise<EpochInfo>
  budget(): SnapshotBudget
}

/** Build a snapshot from live readers, MERGING over the last one: a sub-call that
 *  throws keeps the previous value rather than blanking it. Always resolves. */
export async function collectSnapshot(dataDir: string, cycleId: string, readers: SnapshotReaders): Promise<Snapshot> {
  const prev = readSnapshot(dataDir)
  const safe = async <T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> => {
    try { return await fn() } catch (e) {
      console.error(`orquestra: snapshot ${label} failed, keeping previous value — ${e instanceof Error ? e.message : String(e)}`)
      return fallback
    }
  }
  const balance = await safe(readers.balance, prev?.balance ?? { eth: 0, reppo: 0, veReppo: 0, usdc: 0 }, 'balance')
  const votingPower = await safe(readers.votingPower, prev?.votingPower ?? { power: 0, lockupCount: 0 }, 'votingPower')
  const emissionsDue = await safe(readers.emissionsDue, prev?.emissionsDue ?? { totalReppo: 0, pods: [] }, 'emissionsDue')
  const epoch = await safe(readers.epoch, prev?.epoch ?? { epoch: 0, epochStart: 0, epochDurationSeconds: 0, secondsRemaining: 0 }, 'epoch')
  const ts = new Date().toISOString()
  return { ts, cycleId, balance, votingPower, emissionsDue, epoch, budget: readers.budget() }
}
