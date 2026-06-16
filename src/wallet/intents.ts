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
  /** Optional per-mint REPPO estimate for budgeting. Currently no caller threads a
   *  value (selectMints leaves it 0), so in practice 0/undefined both mean "no
   *  estimate" and executeMint reserves the conservative MINT_REPPO_FALLBACK instead.
   *  Only a positive value here overrides that default. */
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
  /** actual REPPO claimed (read from the claim tx receipt; CLI/contract omit it). */
  reppoClaimed?: number
  /** on-chain fee QUOTE (human units, STRING), from a grant-access result (reppo >=0.8.5).
   *  Present on a NON-REPPO grant so the cycle can show "paid 50 EXY" in the activity log. */
  feeAmount?: string
  /** receipt-derived ACTUAL fee paid (STRING), from a grant-access result — preferred over
   *  feeAmount (the quote) when present. */
  feePaid?: string
  /** the token the access fee was paid in, from a grant-access result (reppo >=0.8.5). */
  feeToken?: { symbol: string; address: string; decimals: number }
  detail?: string
}
