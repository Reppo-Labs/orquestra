// src/voter/select.ts
import { STRICTNESS_THRESHOLDS, type StrictnessLevel } from '../config/schema.js'
import type { VoteRubric } from '../rubric/types.js'
import type { VoteIntent } from '../wallet/intents.js'
import type { VoterPod, VoteFilter, PodScorer } from './types.js'
import { redactSecrets } from '../util/redact.js'

/** Score each votable pod and turn the 1-10 score into a VoteIntent.
 *  up if score >= like-threshold, down if <= dislike-threshold, else skip.
 *  `onSkip` (optional) is called with a redacted per-pod skip reason when a pod's scoring
 *  throws (e.g. a video ingest skip, a non-conforming model response) — the cycle records
 *  it as dashboard activity so an idle datanet explains itself instead of showing nothing. */
export async function selectVotes(
  datanetId: string,
  pods: VoterPod[],
  rubric: VoteRubric,
  strictness: StrictnessLevel,
  filter: VoteFilter,
  scorer: PodScorer,
  onSkip?: (podId: string, reason: string) => void,
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
    // Per-pod isolation: a single pod's scoring failure (e.g. the model returns
    // output that doesn't match the score schema) skips THAT pod, not the whole
    // datanet — the other pods still get scored + voted.
    let result: { score: number; reason: string; panel?: VoteIntent['panel'] }
    try {
      // Pass the thresholds so a tiered (panel) scorer knows the ambiguity band.
      result = await scorer.scorePod(pod, rubric, { like, dislike })
    } catch (e) {
      // Redact: a skip reason can fold in a provider error string that echoes a key.
      const reason = redactSecrets(e instanceof Error ? e.message : String(e))
      console.error(`orquestra: pod ${pod.podId} (datanet ${datanetId}) scoring failed, skipped — ${reason}`)
      onSkip?.(pod.podId, reason)
      continue
    }
    const { score, reason, panel } = result
    const named = pod.name ? { podName: pod.name } : {}
    if (score >= like) {
      intents.push({ kind: 'vote', datanetId, podId: pod.podId, direction: 'up', conviction: score, reason, ...named, ...(panel ? { panel } : {}) })
    } else if (score <= dislike) {
      intents.push({ kind: 'vote', datanetId, podId: pod.podId, direction: 'down', conviction: score, reason, ...named, ...(panel ? { panel } : {}) })
    }
    // mid-range → skip (no intent)
  }
  return intents
}
