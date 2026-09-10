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

/** What the lease endpoint hands this node (participation-triggered settlement;
 *  eval-api openspec job-distribution). The gateway leases NO evidence: the
 *  node grounds the verdict in pods it retrieves itself from the public
 *  datanet catalog (no credential). */
export interface LeasedJob {
  jobId: string
  request: EvalJobRequest
  /** Settlement deadline — answers submitted after this are rejected. The job may settle earlier on participation. */
  answerCutoff: string
}

/** A pod reference the gateway verifies against the datanet API at :complete.
 *  `datanetId` is the datanet's SUBNET CUID (e.g. "cms3uejpj0001jf040zjgwqwm"),
 *  which is what a pod row names as `privateSubnetId` — never the numeric
 *  `tokenId` (it collides across chains, and 66 pods belong to subnets that
 *  /public/subnets does not list at all). Confirmed by live probe 2026-09-04. */
export interface Citation {
  datanetId: string
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
  /** Must name at least one datanet, by subnet cuid: "found nothing" is only
   *  meaningful relative to where the node looked. */
  datanetsSearched: string[]
}

/** One pod as read from a datanet this node can access. `datanetId` is the
 *  subnet cuid the pod belongs to (its row's `privateSubnetId`). */
export interface DatanetPod {
  datanetId: string
  podId: string
  name: string
  text: string
}
