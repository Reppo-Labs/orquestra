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
  status: string
  economics: {
    accessFeeReppo: number
    emissionsPerEpochReppo: number
    upVoteVolume: number
    downVoteVolume: number
    nativeTokenSymbol: string
  }
}
