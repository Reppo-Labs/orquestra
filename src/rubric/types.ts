import type { DatanetYield } from '../voter/yield.js'

export class RubricUnavailableError extends Error {}

/** Economics parsed straight from the datanet's Reppo metadata (rubric/parse.ts).
 *  The live per-epoch yield is NOT here — it is cycle-attached and exists only on
 *  VoteRubric (below), so a loaded rubric can never carry it. */
export interface RubricEconomics {
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
  /** Structurally absent (`never`) on a loaded rubric: the live yield exists only on
   *  VoteRubric. This also makes VoteRubric NON-assignable back to DatanetRubric, so a
   *  yield-carrying rubric cannot be laundered through the base type into a MintRubric. */
  currentYield?: never
}

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
  economics: RubricEconomics
}

/** The rubric fields prompts render (economics-free): every flavor — loaded, vote,
 *  mint — is assignable, so prompt builders don't care which one they hold. */
export type RubricPromptFields = Pick<DatanetRubric, 'name' | 'goal' | 'voterRubric'>

/** Vote-scoped rubric — the ONLY rubric type that can carry the live yield, so any
 *  prompt that renders datanet economics must hold a VoteRubric. */
export interface VoteRubric extends Omit<DatanetRubric, 'economics'> {
  economics: Omit<RubricEconomics, 'currentYield'> & {
    /** Live per-epoch yield, attached by the CYCLE (toVoteRubric) — NOT parsed from CLI
     *  metadata. Timing: attached right BEFORE this cycle's vote scoring (after the pod
     *  fetch, before selectVotes), so the scorer prompt sees THIS cycle's on-chain read.
     *  Absent until a datanet's first scoring pass (src/voter/yield.ts, buildEconomicsBlock). */
    currentYield?: DatanetYield
  }
}

/** Mint-scoped rubric — structurally CANNOT carry the vote yield (`currentYield?: never`):
 *  handing a yield-capable VoteRubric to a MintRubric parameter is a compile error, so
 *  mint prompts can never render datanet economics. */
export interface MintRubric extends Omit<DatanetRubric, 'economics'> {
  economics: RubricEconomics & { currentYield?: never }
}

/** Derive the vote-scoped rubric for ONE scoring pass: a clone carrying this cycle's
 *  yield. Never mutates the (process-cached) input — the same cached object is reused
 *  by the mint path and every later cycle. */
export function toVoteRubric(rubric: DatanetRubric, currentYield?: DatanetYield): VoteRubric {
  return { ...rubric, economics: { ...rubric.economics, ...(currentYield ? { currentYield } : {}) } }
}

/** Derive the mint-scoped rubric: strips any vote yield. Accepts the loaded rubric or
 *  a vote-scoped one so the strip decision lives in exactly one place. */
export function toMintRubric(rubric: DatanetRubric | VoteRubric): MintRubric {
  const { currentYield: _voteOnly, ...economics } = (rubric as VoteRubric).economics
  return { ...rubric, economics }
}
