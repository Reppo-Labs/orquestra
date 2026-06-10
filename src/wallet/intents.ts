// src/wallet/intents.ts
export interface VoteIntent {
  kind: 'vote'
  datanetId: string
  podId: string
  direction: 'up' | 'down'
  /** 1-10 conviction from the voter; used to prioritise scarce voting power. */
  conviction: number
  reason: string
}

export interface MintIntent {
  kind: 'mint'
  datanetId: string
  /** platform subnet UUID for `mint-pod --subnet-uuid` (reppo >=0.8.0). */
  subnetUuid: string
  /** sha256-derived dedup key. */
  canonicalKey: string
  podName: string
  podDescription: string
  /** path to the labeled dataset body the CLI pins + mints. */
  datasetPath: string
  /** optional REPPO cost estimate for budgeting; 0 if mint is gas-only. */
  estReppoCost?: number
  /** scorer's 1-10 quality score; carried for downstream digest/audit. */
  selfScore?: number
  /** human-viewable source page → pod's primary --url (the pinned dataset is attached separately). */
  sourceUrl?: string
  /** pod card image → mint-pod --image-url. */
  imageUrl?: string
}

export interface ClaimIntent {
  kind: 'claim'
  datanetId: string
  podId: string
  epoch: number
  /** unclaimed REPPO this (pod, epoch) is worth at claim time; recorded for PnL. */
  reppoDue: number
  idempotencyKey: string
}

export interface ExecResult {
  ok: boolean
  /** 'executed' | 'refused-budget' | 'error' */
  status: 'executed' | 'refused-budget' | 'error'
  txHash?: string
  /** actual gas (ETH) when known; surfaced for the activity log. */
  gasEth?: number
  detail?: string
}
