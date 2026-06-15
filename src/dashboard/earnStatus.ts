// src/dashboard/earnStatus.ts
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { ActivityEntry } from './activityLog.js'
import type { EmissionsDue } from '../reppo/queryEmissionsDue.js'

const FILE = 'earn-status.json'

/** EarnSummary plus the cycle timestamp it was computed at (persisted each cycle). */
export type PersistedEarn = EarnSummary & { ts: string }

/** Atomic write (tmp + rename), matching the snapshot/ledger persistence pattern. */
export function writeEarnStatus(dataDir: string, earn: PersistedEarn): void {
  const path = join(dataDir, FILE)
  writeFileSync(`${path}.tmp`, JSON.stringify(earn, null, 2))
  renameSync(`${path}.tmp`, path)
}

/** Read the last persisted earn status; null if absent/corrupt. */
export function readEarnStatus(dataDir: string): PersistedEarn | null {
  const path = join(dataDir, FILE)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as PersistedEarn
  } catch {
    return null
  }
}

/** Per-pod vote tallies for our own pods (leading earn signal — emissions follow votes). */
export interface OwnPodVote { podId: string; name: string; validityEpoch: string; upVotes: number; downVotes: number }

export interface EarnSummary {
  /** count of executed mints in the activity log (pods we published). */
  mintedPods: number
  /** Σ reppoClaimed over executed claims. */
  claimedReppo: number
  /** still-unclaimed emissions across our pods (live query). */
  claimableReppo: number
  totalUpVotes: number
  totalDownVotes: number
  pods: OwnPodVote[]
  /** true once any emissions have been claimed OR are claimable — the G1 signal. */
  earning: boolean
}

/** Select OUR pods from the full datanet pod list by matching against the mint
 *  names we recorded. Needed because the on-chain `creator` field comes back empty,
 *  so the CLI's "own pods" filter returns nothing. Tolerates on-chain name truncation
 *  by matching when one name is a prefix of the other (≥12 shared chars). */
export function selectOurPods(allPods: OwnPodVote[], ourPodNames: string[]): OwnPodVote[] {
  const ours = ourPodNames.map((n) => n.trim()).filter((n) => n !== '')
  const matches = (podName: string, ourName: string): boolean => {
    const a = podName.trim(), b = ourName
    if (a === b) return true
    const [short, long] = a.length <= b.length ? [a, b] : [b, a]
    return short.length >= 12 && long.startsWith(short)
  }
  return allPods.filter((p) => ours.some((o) => matches(p.name, o)))
}

/** Pure: roll up the earn-test signal from local activity + a live emissions-due
 *  query + on-chain pod vote tallies. */
export function earnSummary(activity: ActivityEntry[], emissionsDue: EmissionsDue, ownPodVotes: OwnPodVote[]): EarnSummary {
  // Exclude 'backfill' rows — those are pre-dashboard historical placeholders, not pods
  // this node minted; counting them would overstate the earn-test's actual output.
  const mintedPods = activity.filter((e) => e.kind === 'mint' && e.status === 'executed' && e.cycleId !== 'backfill').length
  const claimedReppo = activity
    .filter((e) => e.kind === 'claim' && e.status === 'executed')
    .reduce((s, e) => s + (e.reppoClaimed ?? 0), 0)
  const claimableReppo = emissionsDue.totalReppo
  const totalUpVotes = ownPodVotes.reduce((s, p) => s + p.upVotes, 0)
  const totalDownVotes = ownPodVotes.reduce((s, p) => s + p.downVotes, 0)
  return {
    mintedPods,
    claimedReppo,
    claimableReppo,
    totalUpVotes,
    totalDownVotes,
    pods: ownPodVotes,
    earning: claimedReppo > 0 || claimableReppo > 0,
  }
}

/** Human-readable one-screen earn report, logged each cycle and persisted to
 *  earn-status.json (served at /api/earn). There is no `earn-status` subcommand. */
export function formatEarnStatus(s: EarnSummary): string {
  const lines = [
    '── orquestra · earn status ──',
    `minted pods (executed): ${s.mintedPods}`,
    `claimable REPPO (now):  ${s.claimableReppo}`,
    `claimed REPPO (to date): ${s.claimedReppo}`,
    `pod votes: ${s.totalUpVotes} up / ${s.totalDownVotes} down across ${s.pods.length} pod(s)`,
  ]
  for (const p of s.pods) {
    lines.push(`  pod ${p.podId} (epoch ${p.validityEpoch}): ${p.upVotes}↑ ${p.downVotes}↓ — ${p.name}`)
  }
  lines.push(
    s.earning
      ? `VERDICT: earning — ${s.claimedReppo} claimed + ${s.claimableReppo} claimable REPPO.`
      : s.totalUpVotes > 0
        ? 'VERDICT: not yet earning, but accruing upvotes (emissions lag votes by an epoch) — keep watching.'
        : 'VERDICT: not earning and no upvotes yet — too early, or the data is not winning curation.',
  )
  return lines.join('\n')
}
