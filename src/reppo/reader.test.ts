// src/reppo/reader.test.ts
import { describe, it, expect, vi } from 'vitest'
import { defaultReppoReader } from './reader.js'
import type { ClaimableEmission, EpochInfo, OwnPodVote } from './reader.js'

// The facade is delegation-only: every method forwards to the existing typed
// wrapper (the query files stay the private implementation). Mock the wrappers
// and assert the reader threads arguments through unchanged.
const h = vi.hoisted(() => ({
  listPodsJson: vi.fn(async () => [{ podId: 'p1', validityEpoch: '1', name: 'n', description: 'd' }]),
  queryEmissionsDueJson: vi.fn(async () => ({ totalReppo: 3, pods: [] })),
  queryBalanceJson: vi.fn(async () => ({ veReppo: 7 })),
  queryVotingPowerJson: vi.fn(async () => ({ power: 1, lockupCount: 1 })),
  queryEpochJson: vi.fn(async (): Promise<EpochInfo> => ({ epoch: 5, epochStart: 0, epochDurationSeconds: 0, secondsRemaining: 0 })),
  queryDatanetPodVotes: vi.fn(async (): Promise<OwnPodVote[]> => []),
  listDatanetsJson: vi.fn(async () => []),
  getSubnetEmissionInfo: vi.fn(async () => ({ primaryToken: '0x0', primaryEmissionsPerEpoch: 0n, reppoEmissionsPerEpoch: 0n })),
  readTokenBalance: vi.fn(async () => 42n),
  queryEpochVoteVolume: vi.fn(async () => ({ epoch: 5, totalRaw: 1n })),
  queryClaimableOnchain: vi.fn(async (): Promise<ClaimableEmission[]> => []),
  queryVoterClaimableOnchain: vi.fn(async (): Promise<ClaimableEmission[]> => []),
  makeDbPodCache: vi.fn(() => ({ pod: 'cache' })),
  makeOwnerScanCache: vi.fn(() => ({ owner: 'cache' })),
  makeVoterScanCache: vi.fn(() => ({ voter: 'cache' })),
}))
vi.mock('./listPods.js', async (orig) => ({ ...(await orig<object>()), listPodsJson: h.listPodsJson }))
vi.mock('./queryEmissionsDue.js', () => ({ queryEmissionsDueJson: h.queryEmissionsDueJson }))
vi.mock('./queryBalance.js', () => ({ queryBalanceJson: h.queryBalanceJson }))
vi.mock('./queryVotingPower.js', () => ({ queryVotingPowerJson: h.queryVotingPowerJson }))
vi.mock('./queryEpoch.js', () => ({ queryEpochJson: h.queryEpochJson }))
vi.mock('./queryOwnPods.js', () => ({ queryDatanetPodVotes: h.queryDatanetPodVotes }))
vi.mock('./listDatanets.js', () => ({ listDatanetsJson: h.listDatanetsJson }))
vi.mock('./subnetManager.js', async (orig) => ({ ...(await orig<object>()), getSubnetEmissionInfo: h.getSubnetEmissionInfo }))
vi.mock('./tokenBalance.js', () => ({ readTokenBalance: h.readTokenBalance }))
vi.mock('./epochVotes.js', () => ({ queryEpochVoteVolume: h.queryEpochVoteVolume }))
vi.mock('./emissionsOnchain.js', () => ({ queryClaimableOnchain: h.queryClaimableOnchain, queryVoterClaimableOnchain: h.queryVoterClaimableOnchain }))
vi.mock('./podCacheStore.js', () => ({ makeDbPodCache: h.makeDbPodCache, makeOwnerScanCache: h.makeOwnerScanCache, makeVoterScanCache: h.makeVoterScanCache }))

describe('defaultReppoReader', () => {
  it('delegates CLI reads to the typed wrappers with arguments unchanged', async () => {
    expect(await defaultReppoReader.listPods('9', { all: true })).toHaveLength(1)
    expect(h.listPodsJson).toHaveBeenCalledWith('9', { all: true })
    expect((await defaultReppoReader.emissionsDue()).totalReppo).toBe(3)
    expect((await defaultReppoReader.balance()).veReppo).toBe(7)
    expect((await defaultReppoReader.epoch()).epoch).toBe(5)
    await defaultReppoReader.datanetPodVotes('11')
    expect(h.queryDatanetPodVotes).toHaveBeenCalledWith('11')
    await defaultReppoReader.votingPower()
    expect(h.queryVotingPowerJson).toHaveBeenCalled()
    await defaultReppoReader.listDatanets()
    expect(h.listDatanetsJson).toHaveBeenCalled()
  })

  it('delegates on-chain reads, threading the RPC URL through', async () => {
    expect(await defaultReppoReader.tokenBalance('http://rpc', '0xToken', '0xOwner')).toBe(42n)
    expect(h.readTokenBalance).toHaveBeenCalledWith('http://rpc', '0xToken', '0xOwner')
    await defaultReppoReader.epochVoteVolume('http://rpc', ['1', '2'])
    expect(h.queryEpochVoteVolume).toHaveBeenCalledWith('http://rpc', ['1', '2'])
    await defaultReppoReader.subnetEmissionInfo('http://rpc', '7')
    expect(h.getSubnetEmissionInfo).toHaveBeenCalledWith('http://rpc', '7')
  })

  it('claimableOnchain builds the DB pod cache + owner scan cache from dataDir and forwards floorEpoch', async () => {
    await defaultReppoReader.claimableOnchain('http://rpc', '0xW', '/data', { floorEpoch: 12 })
    expect(h.makeDbPodCache).toHaveBeenCalledWith('/data')
    expect(h.makeOwnerScanCache).toHaveBeenCalledWith('/data')
    expect(h.queryClaimableOnchain).toHaveBeenCalledWith(
      'http://rpc', '0xW', { pod: 'cache' }, { floorEpoch: 12 }, { owner: 'cache' })
  })

  it('voterClaimableOnchain builds the voter scan cache from dataDir and forwards the voted pod ids', async () => {
    await defaultReppoReader.voterClaimableOnchain('http://rpc', '0xW', ['5'], '/data', { floorEpoch: undefined })
    expect(h.makeVoterScanCache).toHaveBeenCalledWith('/data')
    expect(h.queryVoterClaimableOnchain).toHaveBeenCalledWith(
      'http://rpc', '0xW', ['5'], { voter: 'cache' }, { floorEpoch: undefined })
  })
})
