// src/voter/types.ts
import type { DatanetRubric } from '../rubric/types.js'

/** A pod as listed by `reppo list pods --all --datanet <id>`. */
export interface VoterPod {
  podId: string
  validityEpoch: string
  name: string
  description: string
}

/** Pre-rubric filter inputs (from the vote-filter the prefetch/CLI derives). */
export interface VoteFilter {
  /** Only pods at this epoch are votable (null = no epoch gating). */
  currentEpoch: string | null
  /** Pods this wallet minted — voting on them reverts CANNOT_VOTE_FOR_OWN_POD. */
  ownPodIds: string[]
  /** Pods already voted on — re-voting double-spends gas / power. */
  votedPodIds: string[]
}

export interface PodScore {
  /** 1-10 on the datanet's own onboardingVoters scale. */
  score: number
  reason: string
}

/** Scores a pod against a datanet's rubric. Default impl is an LLM; injected in tests. */
export interface PodScorer {
  scorePod(pod: VoterPod, rubric: DatanetRubric): Promise<PodScore>
}
