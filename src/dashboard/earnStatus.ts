// src/dashboard/earnStatus.ts
import type { ActivityEntry } from './activityLog.js'
import type { EmissionsDue } from '../reppo/queryEmissionsDue.js'

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

/** Pure: roll up the earn-test signal from local activity + a live emissions-due
 *  query + on-chain pod vote tallies. */
export function earnSummary(activity: ActivityEntry[], emissionsDue: EmissionsDue, ownPodVotes: OwnPodVote[]): EarnSummary {
  const mintedPods = activity.filter((e) => e.kind === 'mint' && e.status === 'executed').length
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

/** Human-readable one-screen earn report for `orquestra earn-status`. */
export function formatEarnStatus(s: EarnSummary): string {
  const lines = [
    '── orquestra earn-status ──',
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
