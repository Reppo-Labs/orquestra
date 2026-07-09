import type { DatanetYield } from '../voter/yield.js'

export class RubricUnavailableError extends Error {}

/** A datanet's machine-readable policy, derived from its Reppo metadata. */
export interface DatanetRubric {
  datanetId: string
  name: string
  /** subnetDescription — the datanet's goal. */
  goal: string
  /** onboardingPublishers — what good data looks like (mint spec). */
  publisherSpec: string
  /** onboardingVoters — how to score pods 1-10 (vote rubric). */
  voterRubric: string
  /** Platform subnet UUID (cuid) from datanet metadata — REQUIRED by reppo >=0.8.0
   *  `mint-pod --subnet-uuid`. Empty string when metadata predates it (vote-only). */
  subnetUuid: string
  /** Derived capability (two-tier model): true when a voter rubric is present. */
  canVote: boolean
  /** Derived capability: true when a publisher spec is present (a data adapter is checked separately by the minter). */
  canMint: boolean
  status: string
  economics: {
    accessFeeReppo: number
    /** Set ONLY when the datanet charges its access fee in a NON-REPPO primary token
     *  (e.g. $EXY). Undefined for REPPO-fee datanets (the unchanged default path).
     *  Presence is what routes the grant to `grant-access --token primary`.
     *  `amount` is the human-formatted value (display only); `amountRaw` is the raw
     *  integer string (from accessFeePrimaryToken.raw) — the balance gate compares it
     *  raw-to-raw so it never loses precision through a float. */
    accessFeeToken?: { address: string; symbol: string; decimals: number; amount: number; amountRaw: string }
    emissionsPerEpochReppo: number
    upVoteVolume: number
    downVoteVolume: number
    nativeTokenSymbol: string
    /** Live per-epoch yield, attached by the CYCLE — NOT parsed from CLI metadata.
     *  Timing: attached right BEFORE this cycle's vote scoring (after the pod fetch,
     *  before selectVotes), so the scorer prompt sees THIS cycle's on-chain read.
     *  Absent until a datanet's first scoring pass; on the process-lifetime cached
     *  rubric it is overwritten each cycle (src/voter/yield.ts, buildEconomicsBlock). */
    currentYield?: DatanetYield
  }
}
