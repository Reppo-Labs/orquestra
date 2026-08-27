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

/** What the lease endpoint hands this node (epoch model, eval-judge-v1 2b). */
export interface LeasedJob {
  jobId: string
  request: EvalJobRequest
  datanetId: number
  /** Presigned URL of the evidence corpus snapshot every node judges against. */
  corpusUrl: string
  /** Snapshot version the gateway pins citations against at settlement. */
  corpusVersion: string
  /** On-chain datanet epoch this job settles in. */
  epoch: number
  /** Epoch end + grace — answers submitted after this are rejected. */
  answerCutoff: string
}

export interface CriterionVerdict {
  criterion: string
  score: number // 1-10 integer
  critique: string
  citations: string[] // pod ids; [] when evidenceBasis is 'model-judgment'
}

/** What :complete submits. The node is quorum-oblivious: it always judges and
 *  submits; settlement is entirely the gateway's concern. */
export interface EvalAnswer {
  jobId: string
  model: string
  verdicts: CriterionVerdict[]
  evidenceBasis: 'citations' | 'model-judgment'
}

/** One entry of the corpus snapshot fetched from corpusUrl. */
export interface CorpusPod {
  podId: string
  name: string
  text: string
}

export interface CorpusSnapshot {
  datanetId: number
  generatedAt: string
  pods: CorpusPod[]
}
