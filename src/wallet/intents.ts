// src/wallet/intents.ts
import type { PanelTranscript } from '../panel/types.js'

export interface VoteIntent {
  kind: 'vote'
  datanetId: string
  podId: string
  /** human-readable pod name, carried to the activity log so the dashboard can show it. */
  podName?: string
  direction: 'up' | 'down'
  /** 1-10 conviction from the voter; used to prioritise scarce voting power. */
  conviction: number
  reason: string
  /** multi-agent panel transcript when a panel produced this decision (see src/panel). */
  panel?: PanelTranscript
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
  /** path to the labeled dataset body the CLI pins + mints. Absent for url-only mints. */
  datasetPath?: string
  /** optional REPPO cost estimate for budgeting; 0 if mint is gas-only. */
  estReppoCost?: number
  /** scorer's 1-10 quality score; carried for downstream digest/audit. */
  selfScore?: number
  /** scorer's one-line reason for the score; shown in the activity log detail. */
  reason?: string
  /** human-viewable source page → pod's primary --url (the pinned dataset is attached separately). */
  sourceUrl?: string
  /** pod card image → mint-pod --image-url. */
  imageUrl?: string
  /** multi-agent panel transcript when a panel produced this decision (see src/panel). */
  panel?: PanelTranscript
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
