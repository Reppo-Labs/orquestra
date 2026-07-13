// src/reppo/reader.ts
// The single READ facade over src/reppo. Runtime consumers (the cycle wiring in
// src/runtime, the wallet intents) import reads and DOMAIN TYPES from here — never
// from the individual query files, which stay private implementation. Writes
// (vote/mint/claim/grant via exec.ts, platformApi.ts) are NOT part of this seam:
// they go through the WalletExecutor, which enforces the budget before signing.
import type { VoterPod } from '../voter/types.js'
import { listPodsJson } from './listPods.js'
import { queryEmissionsDueJson, type EmissionsDue, type ClaimableEmission } from './queryEmissionsDue.js'
import { queryBalanceJson, type WalletBalance } from './queryBalance.js'
import { queryVotingPowerJson, type VotingPower } from './queryVotingPower.js'
import { queryEpochJson, type EpochInfo } from './queryEpoch.js'
import { queryDatanetPodVotes, type OwnPodVote } from './queryOwnPods.js'
import { listDatanetsJson, type DatanetSummary } from './listDatanets.js'
import { getSubnetEmissionInfo, type SubnetEmissionInfo } from './subnetManager.js'
import { readTokenBalance } from './tokenBalance.js'
import { queryEpochVoteVolume, type EpochVoteVolume } from './epochVotes.js'
import { queryClaimableOnchain, queryVoterClaimableOnchain } from './emissionsOnchain.js'
import { makeDbPodCache, makeVoterScanCache, makeOwnerScanCache } from './podCacheStore.js'

// Domain types live at this seam. Consumers must import them from here so the
// query files can be reshaped without touching every consumer.
export type { ClaimToken, ClaimableEmission, EmissionsDue } from './queryEmissionsDue.js'
export type { EpochInfo } from './queryEpoch.js'
export type { OwnPodVote } from './queryOwnPods.js'
export type { WalletBalance } from './queryBalance.js'
export type { VotingPower } from './queryVotingPower.js'
export type { DatanetSummary, NativeToken } from './listDatanets.js'
export type { EpochVoteVolume } from './epochVotes.js'
export type { SubnetEmissionInfo } from './subnetManager.js'
// Pure helpers that ride along with the reads they interpret.
export { deriveCurrentEpoch } from './listPods.js'
export { formatTokenAmount } from './subnetManager.js'

/** Options for the on-chain emission scans. `floorEpoch` bounds the first-run deep
 *  scan (REPPO_EMISSIONS_FLOOR_EPOCH) so it doesn't crawl from epoch 1. */
export interface OnchainScanOpts { floorEpoch?: number }

/** Unified read surface over the reppo CLI and the Base RPC. CLI reads take no
 *  connection arguments (the CLI owns its own config); on-chain reads take the
 *  RPC URL explicitly because RPC is optional bootstrap configuration. */
export interface ReppoReader {
  // --- reppo CLI reads ---
  listPods(datanetId: string, opts: { all: boolean }): Promise<VoterPod[]>
  /** ALL pods on a datanet with vote tallies (the earn/learn signal). */
  datanetPodVotes(datanetId: string): Promise<OwnPodVote[]>
  /** Platform-API claimable emissions (fallback when no RPC — under-reports). */
  emissionsDue(): Promise<EmissionsDue>
  balance(): Promise<WalletBalance>
  votingPower(): Promise<VotingPower>
  epoch(): Promise<EpochInfo>
  listDatanets(): Promise<DatanetSummary[]>
  // --- on-chain (RPC) reads ---
  subnetEmissionInfo(rpcUrl: string, subnetId: string): Promise<SubnetEmissionInfo>
  /** RAW ERC20 balanceOf(owner) — no decimals scaling (raw-to-raw fee pre-check). */
  tokenBalance(rpcUrl: string, token: string, owner: string): Promise<bigint>
  /** Σ current-epoch vote weight across pods (raw 18-dec) + the epoch read. */
  epochVoteVolume(rpcUrl: string, podIds: string[]): Promise<EpochVoteVolume>
  /** Claimable OWNER (pod,epoch) detected on-chain; caches are DB-backed in dataDir. */
  claimableOnchain(rpcUrl: string, wallet: string, dataDir: string, opts?: OnchainScanOpts): Promise<ClaimableEmission[]>
  /** Claimable VOTER (pod,epoch) on pods the wallet voted on (not owned). */
  voterClaimableOnchain(rpcUrl: string, wallet: string, votedPodIds: string[], dataDir: string, opts?: OnchainScanOpts): Promise<ClaimableEmission[]>
}

/** Production reader: pure delegation to the typed wrappers. */
export const defaultReppoReader: ReppoReader = {
  listPods: (datanetId, opts) => listPodsJson(datanetId, opts),
  datanetPodVotes: (datanetId) => queryDatanetPodVotes(datanetId),
  emissionsDue: () => queryEmissionsDueJson(),
  balance: () => queryBalanceJson(),
  votingPower: () => queryVotingPowerJson(),
  epoch: () => queryEpochJson(),
  listDatanets: () => listDatanetsJson(),
  subnetEmissionInfo: (rpcUrl, subnetId) => getSubnetEmissionInfo(rpcUrl, subnetId),
  tokenBalance: (rpcUrl, token, owner) => readTokenBalance(rpcUrl, token, owner),
  epochVoteVolume: (rpcUrl, podIds) => queryEpochVoteVolume(rpcUrl, podIds),
  claimableOnchain: (rpcUrl, wallet, dataDir, opts) =>
    queryClaimableOnchain(rpcUrl, wallet, makeDbPodCache(dataDir), { floorEpoch: opts?.floorEpoch }, makeOwnerScanCache(dataDir)),
  voterClaimableOnchain: (rpcUrl, wallet, votedPodIds, dataDir, opts) =>
    queryVoterClaimableOnchain(rpcUrl, wallet, votedPodIds, makeVoterScanCache(dataDir), { floorEpoch: opts?.floorEpoch }),
}
