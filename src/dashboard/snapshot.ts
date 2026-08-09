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
import type { DatanetYield } from '../voter/yield.js'

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
  /** Per-datanet emission economics from THIS cycle (rate, epoch vote volume, yield).
   *  Copied verbatim from the cycle report — fresh each cycle, deliberately NOT merged
   *  over the previous snapshot (a stale yield is worse than an absent one). Optional
   *  for back-compat with pre-feature rows. */
  datanetEconomics?: DatanetYield[]
  /** true when the wallet's ETH is below LOW_GAS_WARN_ETH — every vote/mint/claim is an
   *  on-chain tx, so an empty gas tank silently stalls the whole node (each attempt fails
   *  per-datanet and the cycle carries on). Optional for back-compat with pre-feature rows. */
  lowGas?: boolean
  /** How THIS cycle sized its votes, plus the per-epoch vote-power budget behind it.
   *  Copied verbatim from the cycle report — fresh each cycle, deliberately NOT merged
   *  over the previous snapshot: a stale "you have power left" is worse than an absent
   *  one, and the sizing mode describes the cycle that just ran. Absent = the node has
   *  no vote-enabled datanet, or the row predates the field. */
  votePower?: VotePowerView
}

/** Which sizing the vote pass actually used this cycle. `ve-reppo` is the real thing
 *  (src/voter/weight.ts sizes from votingPower − votesCasted); both `legacy-*` modes
 *  mean every vote landed as conviction×1e18 dust next to the wallet's stake, which is
 *  invisible to an operator who never reads stderr. The two degraded causes are NOT
 *  interchangeable: `no-rpc` is a permanent misconfiguration (RPC_URL unset) that only
 *  the operator can fix, `read-failed` is this cycle's RPC blip and self-heals. */
export type VoteSizingMode = 've-reppo' | 'legacy-no-rpc' | 'legacy-read-failed'

/** The wallet's per-epoch vote-power budget as the dashboard sees it.
 *  Amounts are raw 18-dec DECIMAL STRINGS: they are bigints on the read path
 *  (src/reppo/votePower.ts) and bigint does not survive JSON.stringify into the
 *  snapshot table. They are ABSENT — never 0 — whenever the read did not happen or
 *  failed, so an RPC blip renders as "unread", not as a wallet with no power. */
export interface VotePowerView {
  sizing: VoteSizingMode
  /** full veREPPO voting power (the TOTAL — not what is still spendable). */
  votingPowerWei?: string
  /** votes already cast THIS epoch: votesCastedByVoterForEpoch, read on-chain. This is
   *  the value operators were cross-checking with external scripts — it is the proof
   *  that a cast vote carried real weight. */
  votesCastedWei?: string
  /** still spendable this epoch: votingPower − votesCasted, floored at 0. */
  remainingWei?: string
  epoch?: number
}

/** Warn threshold for the wallet's ETH balance. Base txs are cheap (a vote lands well
 *  under 1e-4 ETH), but below this an epoch's worth of votes (~50) is no longer covered
 *  and the node is about to start failing every signature for gas. */
export const LOW_GAS_WARN_ETH = 0.001

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

/** Replace the llm usage block on an already-written cycle row (latest row for that
 *  cycleId). The cycle writes its snapshot BEFORE reflection runs (earn-status reads it
 *  immediately), but reflection makes LLM calls too — without this second attach those
 *  tokens would be wiped by the next cycle's reset and never reported. No-op when the
 *  cycle row is missing or its JSON is corrupt (never throws into the loop). */
export function attachSnapshotLlm(dataDir: string, cycleId: string, llm: NonNullable<Snapshot['llm']>): void {
  const d = conn(dataDir)
  const row = d.prepare('SELECT id, data FROM snapshot WHERE cycleId = ? ORDER BY id DESC LIMIT 1').get(cycleId) as
    | { id: number; data: string }
    | undefined
  if (!row) return
  try {
    const snap = JSON.parse(row.data) as Snapshot
    snap.llm = llm
    d.prepare('UPDATE snapshot SET data = ? WHERE id = ?').run(JSON.stringify(snap), row.id)
  } catch { /* corrupt row — leave it; the pre-reflection llm block already stands */ }
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
  const lowGas = balance.eth < LOW_GAS_WARN_ETH
  if (lowGas) {
    console.error(
      `orquestra: WARNING — wallet ETH balance ${balance.eth} is below ${LOW_GAS_WARN_ETH}: ` +
      'votes/mints/claims are about to start failing for gas. Top up the wallet with ETH on Base.',
    )
  }
  return { ts, cycleId, balance, votingPower, emissionsDue, epoch, budget: readers.budget(), lowGas }
}
