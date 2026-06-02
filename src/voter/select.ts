// src/voter/select.ts
import { STRICTNESS_THRESHOLDS, type StrictnessLevel } from '../config/schema.js'
import type { DatanetRubric } from '../rubric/types.js'
import type { VoteIntent } from '../wallet/intents.js'
import type { VoterPod, VoteFilter, PodScorer } from './types.js'

/** Score each votable pod and turn the 1-10 score into a VoteIntent.
 *  up if score >= like-threshold, down if <= dislike-threshold, else skip. */
export async function selectVotes(
  datanetId: string,
  pods: VoterPod[],
  rubric: DatanetRubric,
  strictness: StrictnessLevel,
  filter: VoteFilter,
  scorer: PodScorer,
): Promise<VoteIntent[]> {
  if (!rubric.canVote) return []
  const { like, dislike } = STRICTNESS_THRESHOLDS[strictness]
  const own = new Set(filter.ownPodIds)
  const voted = new Set(filter.votedPodIds)

  const eligible = pods.filter(
    (p) =>
      (filter.currentEpoch === null || String(p.validityEpoch) === filter.currentEpoch) &&
      !own.has(p.podId) &&
      !voted.has(p.podId),
  )

  const intents: VoteIntent[] = []
  for (const pod of eligible) {
    const { score, reason } = await scorer.scorePod(pod, rubric)
    if (score >= like) {
      intents.push({ kind: 'vote', datanetId, podId: pod.podId, direction: 'up', conviction: score, reason })
    } else if (score <= dislike) {
      intents.push({ kind: 'vote', datanetId, podId: pod.podId, direction: 'down', conviction: score, reason })
    }
    // mid-range → skip (no intent)
  }
  return intents
}
