// src/dashboard/snapshot.ts
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WalletBalance } from '../reppo/queryBalance.js'
import type { VotingPower } from '../reppo/queryVotingPower.js'
import type { EmissionsDue } from '../reppo/queryEmissionsDue.js'
import type { BudgetCaps } from '../wallet/ledger.js'

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
}

const FILE = 'snapshot.json'

export function writeSnapshot(dataDir: string, snap: Snapshot): void {
  const path = join(dataDir, FILE)
  writeFileSync(`${path}.tmp`, JSON.stringify(snap, null, 2)); renameSync(`${path}.tmp`, path)
}

export function readSnapshot(dataDir: string): Snapshot | null {
  const path = join(dataDir, FILE)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf-8')) as Snapshot } catch { return null }
}

export interface SnapshotReaders {
  balance(): Promise<WalletBalance>
  votingPower(): Promise<VotingPower>
  emissionsDue(): Promise<EmissionsDue>
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
  const ts = new Date().toISOString()
  return { ts, cycleId, balance, votingPower, emissionsDue, budget: readers.budget() }
}
