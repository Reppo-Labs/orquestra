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
  /** Derived capability (two-tier model): true when a voter rubric is present. */
  canVote: boolean
  /** Derived capability: true when a publisher spec is present (a data adapter is checked separately by the minter). */
  canMint: boolean
  status: string
  economics: {
    accessFeeReppo: number
    emissionsPerEpochReppo: number
    upVoteVolume: number
    downVoteVolume: number
    nativeTokenSymbol: string
  }
}
