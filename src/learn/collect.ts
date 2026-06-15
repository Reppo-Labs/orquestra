// src/learn/collect.ts
// Observe step of the self-learning loop: match our matured vote/mint decisions to the
// pod's on-chain tally (the SAME OwnPodVote[] already fetched each cycle for earn-status
// — no extra CLI calls) and persist them as `outcomes`.
//
// IMPORTANT framing (see the design doc): the only observable signal is the crowd's
// up/down tally — there is NO per-vote REPPO attribution. `aligned` here means "our vote
// direction agreed with the crowd's net tally". It is recorded as a raw signal, but the
// reflection step must turn it into rubric-CALIBRATION lessons, never "follow the crowd".
import { readActivity, type ActivityEntry } from '../dashboard/activityLog.js'
import { selectOurPods, type OwnPodVote } from '../dashboard/earnStatus.js'
import { upsertOutcome, readOutcomes, type OutcomeRow } from './store.js'

/** Epochs past a pod's validityEpoch before its tally is treated as final. */
const MATURITY_EPOCHS = 1
/** Minimum total votes before a pod's tally is a usable signal. Also the v1 guard
 *  against self-fulfilling contamination: a pod dominated by our own single vote
 *  (total < MIN_VOTES) is excluded until enough independent voters weigh in. */
const MIN_VOTES = 5
/** Minimum |up-down|/(up+down): a near-tie has no clear sign → excluded. */
const MIN_MARGIN = 0.2

function aligned(kind: OutcomeRow['kind'], direction: OutcomeRow['direction'], netVotes: number): 0 | 1 {
  if (kind === 'mint') return netVotes > 0 ? 1 : 0
  return direction === 'up' ? (netVotes > 0 ? 1 : 0) : (netVotes <= 0 ? 1 : 0)
}

function toOutcome(datanetId: string, kind: OutcomeRow['kind'], e: ActivityEntry, pod: OwnPodVote, currentEpoch: number): OutcomeRow {
  const upVotes = pod.upVotes ?? 0
  const downVotes = pod.downVotes ?? 0
  const total = upVotes + downVotes
  const netVotes = upVotes - downVotes
  const marginPct = total > 0 ? Math.abs(netVotes) / total : 0
  const past = currentEpoch >= Number(pod.validityEpoch) + MATURITY_EPOCHS
  const matured: 0 | 1 = past && total >= MIN_VOTES && marginPct >= MIN_MARGIN ? 1 : 0
  return {
    datanetId, podId: pod.podId, podName: pod.name, kind,
    direction: kind === 'vote' ? e.direction : undefined,
    conviction: e.conviction, judgeScore: e.panel?.judge?.score,
    observedEpoch: currentEpoch,
    upVotes, downVotes, netVotes, marginPct,
    aligned: aligned(kind, e.direction, netVotes),
    matured,
    frozen: matured, // freeze once matured so the learning input never drifts afterward
  }
}

/** Pure: join executed vote/mint activity for a datanet to the pod tallies. Votes
 *  match by podId; mints by recorded name (reusing earn-status's selectOurPods, since
 *  on-chain `creator` is empty). Pods not present in `podVotes` are skipped. */
export function buildOutcomes(
  datanetId: string,
  activity: ActivityEntry[],
  podVotes: OwnPodVote[],
  currentEpoch: number,
): OutcomeRow[] {
  const byId = new Map(podVotes.map((p) => [p.podId, p]))
  const out: OutcomeRow[] = []
  for (const e of activity) {
    if (e.status !== 'executed') continue
    if (e.kind === 'vote' && e.podId) {
      const pod = byId.get(e.podId)
      if (pod) out.push(toOutcome(datanetId, 'vote', e, pod, currentEpoch))
    } else if (e.kind === 'mint' && e.podName) {
      // Record ONLY when the name resolves to exactly one pod. selectOurPods does a
      // prefix match (>=12 shared chars) and can return several (clamped names, the
      // same dataset minted twice) in unspecified order — taking "the first" could
      // freeze the wrong tally or create two outcome rows for one minted pod.
      const cands = selectOurPods(podVotes, [e.podName])
      if (cands.length === 1) out.push(toOutcome(datanetId, 'mint', e, cands[0], currentEpoch))
    }
  }
  return out
}

/** Thin IO orchestrator: read this datanet's executed vote/mint activity, build
 *  outcomes from the already-fetched tallies, and UPSERT each (frozen rows untouched).
 *  Returns the count written. Reuses the cycle's `podVotes` — no new CLI call. */
export function collectOutcomes(dataDir: string, datanetId: string, podVotes: OwnPodVote[], currentEpoch: number): number {
  // Already-frozen outcomes are immutable; skip re-writing them so per-cycle work is
  // bounded by live (not-yet-matured) decisions, not by total history.
  const frozen = new Set(
    readOutcomes(dataDir, datanetId).filter((o) => o.frozen === 1).map((o) => `${o.kind}:${o.podId}`),
  )
  const activity = readActivity(dataDir, { limit: 100_000 }).filter(
    (e) => e.datanetId === datanetId && (e.kind === 'vote' || e.kind === 'mint') && e.status === 'executed',
  )
  const rows = buildOutcomes(datanetId, activity, podVotes, currentEpoch).filter((r) => !frozen.has(`${r.kind}:${r.podId}`))
  for (const r of rows) upsertOutcome(dataDir, r)
  return rows.length
}
