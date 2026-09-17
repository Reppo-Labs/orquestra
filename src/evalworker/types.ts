// Wire types for the Reppo Evaluation API gateway's lease/ack protocol.
// This contract is pinned by test/fixtures/lease-ack/ — the same fixtures run
// against the gateway (eval-api repo). Do not change shapes here without
// updating the fixtures on BOTH sides.

export const EVAL_TYPES = ['answer', 'plan', 'trace', 'artifact'] as const
export type EvalType = (typeof EVAL_TYPES)[number]

export interface EvalJobRequest {
  type: EvalType
  payload: string
  /** Present only on legacy gateway leases during the rollout window. */
  criteria?: string[]
  context?: string
}

/**
 * The request as LEASED (eval-api openspec metered-payloads D9): the payload
 * by reference — `payloadUrl` is a presigned GET valid ~15 min, `payloadBytes`
 * and `payloadSha256` let the node verify what it fetched — and, during the
 * transition, possibly inline too. `resolvePayload` (payload.ts) turns this
 * into the EvalJobRequest the gate and judge consume. A pre-migration gateway
 * sends only `payload`.
 */
export interface LeasedRequest {
  type: EvalType
  /** Present only on legacy gateway leases during the rollout window. */
  criteria?: string[]
  context?: string
  payloadUrl?: string
  payloadBytes?: number
  payloadSha256?: string
  payload?: string
}

/** `:fail` reason vocabulary (test/fixtures/lease-ack/error-codes.json → fail). */
export const FAIL_REASONS = ['PAYLOAD_FETCH_FAILED', 'PAYLOAD_HASH_MISMATCH', 'DATANET_UNAVAILABLE', 'BUDGET_EXHAUSTED', 'PAST_CUTOFF', 'OTHER'] as const
export type FailReason = (typeof FAIL_REASONS)[number]

/** What the lease endpoint hands this node (participation-triggered settlement;
 *  eval-api openspec job-distribution). The gateway leases NO evidence: the
 *  node grounds the verdict in pods it retrieves itself from the public
 *  datanet catalog (no credential). */
export interface LeasedJob {
  jobId: string
  request: LeasedRequest
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

export interface Verdict {
  score: number // 1-10 integer
  critique: string
  /** Non-empty: every verdict must be grounded in at least one pod
   *  (422 UNGROUNDED_VERDICT otherwise). */
  citations: Citation[]
}

export interface CriterionVerdict extends Verdict {
  criterion: string
}

/** What :complete submits. The node is quorum-oblivious: it always judges and
 *  submits; settlement is entirely the gateway's concern. */
export type EvalAnswer = { jobId: string; model: string } &
  (Verdict | { verdicts: CriterionVerdict[] })

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
