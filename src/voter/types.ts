// src/voter/types.ts
import type { DatanetRubric } from '../rubric/types.js'
import type { PanelTranscript } from '../panel/types.js'

/** A pod as listed by `reppo list pods --all --datanet <id>`. */
export interface VoterPod {
  podId: string
  validityEpoch: string
  name: string
  description: string
  /** IPFS content URL (the pod's dataset); used to enrich `description` for scoring. */
  url?: string
  /** (Phase B) The pod's media URL when the pod is a video (Content-Type video/*).
   *  Distinct from the text `description`; the scorer hands this to a multimodal model. */
  mediaUrl?: string
  /** (Phase B) The media MIME type captured at detection (e.g. 'video/mp4'). */
  mediaType?: string
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
  /** present when a multi-agent panel produced this score (see src/panel). */
  panel?: PanelTranscript
}

/** Like/dislike cut points for the datanet's strictness (from STRICTNESS_THRESHOLDS).
 *  Optional context: a tiered scorer uses it to decide whether to convene a panel. */
export interface ScoreThresholds {
  like: number
  dislike: number
}

/** Scores a pod against a datanet's rubric. Default impl is an LLM; injected in tests.
 *  `thresholds` is optional context for tiered scorers; plain scorers ignore it. */
export interface PodScorer {
  scorePod(pod: VoterPod, rubric: DatanetRubric, thresholds?: ScoreThresholds): Promise<PodScore>
}
