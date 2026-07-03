// src/dashboard/earnStatus.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { earnSummary, formatEarnStatus, writeEarnStatus, readEarnStatus, selectOurPods, type OwnPodVote } from './earnStatus.js'
import type { ActivityEntry } from './activityLog.js'
import type { EmissionsDue } from '../reppo/queryEmissionsDue.js'

const mint = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({ ts: 't', cycleId: 'c', kind: 'mint', datanetId: '9', canonicalKey: 'k', status: 'executed', ...over })
const claim = (reppo: number, status: ActivityEntry['status'] = 'executed'): ActivityEntry => ({ ts: 't', cycleId: 'c', kind: 'claim', datanetId: '9', podId: '1', epoch: 99, reppoClaimed: reppo, status })
const due = (totalReppo: number): EmissionsDue => ({ totalReppo, pods: [] })
const pod = (over: Partial<OwnPodVote> = {}): OwnPodVote => ({ podId: '1', name: 'HL perps', validityEpoch: '99', upVotes: 0, downVotes: 0, ...over })

describe('earnSummary', () => {
  it('counts executed mints, sums claimed, carries claimable + vote tallies', () => {
    const s = earnSummary(
      [mint(), mint({ status: 'error' }), mint({ cycleId: 'backfill' }), claim(12.5), claim(4, 'error')],
      due(3),
      [pod({ upVotes: 5, downVotes: 1 }), pod({ podId: '2', upVotes: 2, downVotes: 0 })],
    )
    expect(s.mintedPods).toBe(1)         // only executed, node-era (backfill rows excluded)
    expect(s.claimedReppo).toBe(12.5)    // only executed claim
    expect(s.claimableReppo).toBe(3)
    expect(s.totalUpVotes).toBe(7)
    expect(s.totalDownVotes).toBe(1)
    expect(s.earning).toBe(true)         // claimed > 0
  })

  it('earning is true when only claimable (not yet claimed)', () => {
    expect(earnSummary([mint()], due(5), []).earning).toBe(true)
  })

  it('earning is false when nothing claimed or claimable', () => {
    expect(earnSummary([mint()], due(0), [pod({ upVotes: 3 })]).earning).toBe(false)
  })

  it('counts claimable (pod,epoch) pairs — on-chain detection knows pairs but not amounts', () => {
    const onchainDue: EmissionsDue = { totalReppo: 0, pods: [
      { podId: '5', datanetId: '', epoch: 90, reppo: 0 },
      { podId: '5', datanetId: '', epoch: 102, reppo: 0 },
    ] }
    const s = earnSummary([mint()], onchainDue, [])
    expect(s.claimablePairs).toBe(2)
    expect(s.earning).toBe(true) // pending pairs count as earning even with unknown amounts
  })

  it('aggregates NON-REPPO claimed tokens per symbol, kept separate from claimedReppo', () => {
    const tokenClaim = (symbol: string, amount: number): ActivityEntry => ({
      ts: 't', cycleId: 'c', kind: 'claim', datanetId: '22', podId: '1', epoch: 99,
      reppoClaimed: 0, claimedTokenSymbol: symbol, claimedTokenAmount: amount, status: 'executed',
    })
    const s = earnSummary([tokenClaim('LBM', 40000), tokenClaim('LBM', 10000), tokenClaim('ROBA', 5)], due(0), [])
    expect(s.claimedReppo).toBe(0)
    expect(s.claimedTokens).toEqual([{ symbol: 'LBM', amount: 50000 }, { symbol: 'ROBA', amount: 5 }])
    expect(s.earning).toBe(true) // native-token claims count as earning even with 0 REPPO
  })
})

describe('formatEarnStatus', () => {
  it('renders an earning verdict', () => {
    const out = formatEarnStatus(earnSummary([mint()], due(5), [pod({ upVotes: 2 })]))
    expect(out).toMatch(/VERDICT: earning/)
    expect(out).toMatch(/claimable REPPO \(now\):  5/)
  })
  it('renders the "accruing upvotes" verdict when votes>0 but no emissions yet', () => {
    const out = formatEarnStatus(earnSummary([mint()], due(0), [pod({ upVotes: 4 })]))
    expect(out).toMatch(/accruing upvotes/)
  })
  it('renders the "too early" verdict when nothing yet', () => {
    const out = formatEarnStatus(earnSummary([mint()], due(0), []))
    expect(out).toMatch(/too early/)
  })
  it('shows pending pair count when amounts are unknown (on-chain detection)', () => {
    const onchainDue: EmissionsDue = { totalReppo: 0, pods: [{ podId: '5', datanetId: '', epoch: 90, reppo: 0 }] }
    const out = formatEarnStatus(earnSummary([mint()], onchainDue, []))
    expect(out).toMatch(/claimable REPPO \(now\):  0 \(1 unclaimed pod-epoch pair\)/)
  })
})

describe('selectOurPods (creator is empty on-chain → match by our recorded mint names)', () => {
  const all: OwnPodVote[] = [
    { podId: '764', name: 'HL perps, 0x3dd4..7a81: 17 trades', validityEpoch: '102', upVotes: 0, downVotes: 2227 },
    { podId: '700', name: 'Someone else pod', validityEpoch: '102', upVotes: 999, downVotes: 0 },
    { podId: '825', name: 'HL perps 172s, 0x3200..c407: 1152 trades (BTC/ETH/', validityEpoch: '103', upVotes: 5, downVotes: 0 }, // on-chain TRUNCATED
  ]
  it('matches our pods by exact recorded name', () => {
    const ours = selectOurPods(all, ['HL perps, 0x3dd4..7a81: 17 trades'])
    expect(ours.map((p) => p.podId)).toEqual(['764'])
  })
  it('tolerates on-chain name truncation (our full name vs truncated chain name)', () => {
    const ours = selectOurPods(all, ['HL perps 172s, 0x3200..c407: 1152 trades (BTC/ETH/SOL)'])
    expect(ours.map((p) => p.podId)).toEqual(['825'])
  })
  it('does not match unrelated pods', () => {
    expect(selectOurPods(all, ['HL perps, 0x3dd4..7a81: 17 trades'])).not.toContainEqual(expect.objectContaining({ podId: '700' }))
  })
})

describe('earn-status persistence', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-earn-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('round-trips the persisted earn status', () => {
    const earn = { ...earnSummary([mint()], due(5), [pod({ upVotes: 2 })]), ts: '2026-06-07T00:00:00.000Z' }
    writeEarnStatus(dir, earn)
    expect(readEarnStatus(dir)).toEqual(earn)
  })
  it('returns null when absent', () => {
    expect(readEarnStatus(dir)).toBeNull()
  })
  it('keeps history and reads the latest write', () => {
    const a = { ...earnSummary([mint()], due(1), []), ts: '2026-06-07T00:00:00.000Z' }
    const b = { ...earnSummary([mint(), mint()], due(2), []), ts: '2026-06-08T00:00:00.000Z' }
    writeEarnStatus(dir, a)
    writeEarnStatus(dir, b)
    expect(readEarnStatus(dir)?.ts).toBe('2026-06-08T00:00:00.000Z')
    expect(readEarnStatus(dir)?.claimableReppo).toBe(2)
  })
  it('imports a legacy earn-status.json once, then renames it .imported', () => {
    const earn = { ...earnSummary([mint()], due(5), [pod({ upVotes: 2 })]), ts: '2026-06-07T00:00:00.000Z' }
    writeFileSync(join(dir, 'earn-status.json'), JSON.stringify(earn))
    expect(readEarnStatus(dir)).toEqual(earn)                         // first read triggers import
    expect(existsSync(join(dir, 'earn-status.json'))).toBe(false)
    expect(existsSync(join(dir, 'earn-status.json.imported'))).toBe(true)
  })
})
