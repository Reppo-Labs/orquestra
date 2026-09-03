// Wire types for the Reppo Evaluation API gateway's lease/ack protocol.
// This contract is pinned by test/fixtures/lease-ack/ — the same fixtures run
// against the gateway (eval-api repo). Do not change shapes here without
// updating the fixtures on BOTH sides.

export const EVAL_TYPES = ['answer', 'plan', 'trace', 'artifact'] as const
export type EvalType = (typeof EVAL_TYPES)[number]

export interface EvalJobRequest {
  type: EvalType
  payload: string
  criteria: string[]
  context?: string
}

/** What the lease endpoint hands this node (epoch model, eval-judge-v1 2b).
 *  The gateway leases NO evidence: the node grounds the verdict in pods it
 *  retrieves itself from the datanets its own credentials can read. */
export interface LeasedJob {
  jobId: string
  request: EvalJobRequest
  /** On-chain datanet epoch this job settles in. */
  epoch: number
  /** Epoch end + grace — answers submitted after this are rejected. */
  answerCutoff: string
}

/** A pod reference the gateway verifies against the datanet API at :complete. */
export interface Citation {
  datanetId: number
  podId: string
}

export interface CriterionVerdict {
  criterion: string
  score: number // 1-10 integer
  critique: string
  /** Non-empty: every verdict must be grounded in at least one pod
   *  (422 UNGROUNDED_VERDICT otherwise). */
  citations: Citation[]
}

/** What :complete submits. The node is quorum-oblivious: it always judges and
 *  submits; settlement is entirely the gateway's concern. */
export interface EvalAnswer {
  jobId: string
  model: string
  verdicts: CriterionVerdict[]
}

/** What :deny submits — the node looked and found nothing usable. Never a fault. */
export interface EvalDenial {
  jobId: string
  reason: string
  /** Must name at least one datanet: "found nothing" is only meaningful
   *  relative to where the node looked. */
  datanetsSearched: number[]
}

/** One pod as read from a datanet this node can access. */
export interface DatanetPod {
  datanetId: number
  podId: string
  name: string
  text: string
}
