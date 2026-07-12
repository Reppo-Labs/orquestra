// Integration test: drive vote + mint + claim through the REAL WalletExecutor + REAL
// BudgetLedger (SQLite-backed, persisting to a temp DATA_DIR) and record each ExecResult
// into the REAL activityLog (same SQLite db). Asserts the reserve → reconcile → activity-row
// shapes line up end-to-end, and that spend survives a fresh ledger reopened from disk —
// the round-trip that per-method unit mocks hide.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BudgetLedger } from '../../src/wallet/ledger.js'
import { WalletExecutor } from '../../src/wallet/executor.js'
import { appendActivity, readActivity, sumMintReppoSpent, sumClaimedReppo } from '../../src/dashboard/activityLog.js'
import type { ReppoCli } from '../../src/reppo/cli.js'
import type { VoteIntent, MintIntent, ClaimIntent, ExecResult } from '../../src/wallet/intents.js'
import type { ActivityEntry } from '../../src/dashboard/activityLog.js'

const caps = { voteGasEthMax: 0.05, voteRateMaxPerCycle: 5, mintReppoMax: 100, mintGasEthMax: 0.1, claimGasEthMax: 0.05 }

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-ledger-activity-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const cli = (): ReppoCli => ({
  lock: vi.fn(async () => ({ txHash: '0xlock', gasEth: 0 })),
  vote: vi.fn(async () => ({ txHash: '0xvote', gasEth: 0.001 })),
  mintPod: vi.fn(async () => ({ txHash: '0xmint', gasEth: 0.01, podId: '508' })),
  claimEmissions: vi.fn(async () => ({ txHash: '0xclaim', gasEth: 0.0009 })),
  claimVoterEmissions: vi.fn(async () => ({ txHash: '0xvclaim', gasEth: 0.0009 })),
  grantAccess: vi.fn(async () => ({ txHash: '0xgrant', gasEth: 0 })),
})

// Translate an ExecResult into the activity row the real cycle records, so the persisted
// shapes are exactly what the dashboard/PnL later read back.
const rowFrom = (kind: ActivityEntry['kind'], datanetId: string, r: ExecResult, extra: Partial<ActivityEntry> = {}): ActivityEntry => ({
  ts: new Date().toISOString(), cycleId: 'c1', kind, datanetId, status: r.status,
  ...(r.txHash ? { txHash: r.txHash } : {}),
  ...(r.gasEth !== undefined ? { gasEth: r.gasEth } : {}),
  ...(r.detail ? { detail: r.detail } : {}),
  ...extra,
})

describe('ledger + executor + activityLog round-trip (real SQLite, temp DATA_DIR)', () => {
  it('reserves, reconciles, and persists a full vote→mint→claim flow whose rows agree with ledger spend', async () => {
    const ledger = new BudgetLedger(dir, caps)
    ledger.startCycle('c1')
    const reppoFeeReader = vi.fn(async () => 40) // on-chain mint fee: 40 REPPO
    const claimReppoReader = vi.fn(async () => 12.5) // claim receipt paid 12.5 REPPO
    const ex = new WalletExecutor(cli(), ledger, reppoFeeReader, claimReppoReader)

    // 1) vote
    const voteIntent: VoteIntent = { kind: 'vote', datanetId: '9', podId: 'p1', direction: 'up', conviction: 8, reason: 'aligned' }
    const vote = await ex.executeVote(voteIntent)
    expect(vote.status).toBe('executed')
    appendActivity(dir, rowFrom('vote', '9', vote, { podId: 'p1', direction: 'up', conviction: 8 }))

    // 2) mint
    // estReppoCost 40 reserves 40 pre-sign (fits the 100 cap); the receipt reader reconciles to
    // the same 40. Without an estimate the executor would reserve the 200 fallback and refuse.
    const mintIntent: MintIntent = { kind: 'mint', datanetId: '9', subnetUuid: 'cm-9', canonicalKey: 'k1', podName: 'Pod One', podDescription: 'd', datasetPath: '/tmp/x.json', estReppoCost: 40 }
    const mint = await ex.executeMint(mintIntent)
    expect(mint.status).toBe('executed')
    expect(mint.reppoSpent).toBe(40)
    appendActivity(dir, rowFrom('mint', '9', mint, { canonicalKey: 'k1', podName: 'Pod One', podId: mint.podId, reppoSpent: mint.reppoSpent }))

    // 3) claim
    const claimIntent: ClaimIntent = { kind: 'claim', datanetId: '9', podId: 'p1', epoch: 101, reppoDue: 12.5, idempotencyKey: 'claim-p1-101' }
    const claim = await ex.executeClaim(claimIntent)
    expect(claim.status).toBe('executed')
    appendActivity(dir, rowFrom('claim', '9', claim, { podId: 'p1', epoch: 101, reppoClaimed: claim.reppoClaimed }))

    // --- Ledger spend reflects the reconciled actuals (reserve → reconcile line up) ---
    expect(ledger.state.votesCastThisCycle).toBe(1)
    expect(ledger.state.voteGasSpentEth).toBeCloseTo(0.001)   // reconciled from the 0.003 estimate
    expect(ledger.state.mintReppoSpent).toBe(40)              // reconciled to the on-chain fee, not the 200 fallback
    expect(ledger.state.mintGasSpentEth).toBeCloseTo(0.01)
    expect(ledger.state.claimGasSpentEth).toBeCloseTo(0.0009)

    // --- Activity rows persisted with shapes that match the ExecResults ---
    const rows = readActivity(dir, { limit: 100 })
    expect(rows).toHaveLength(3) // newest-first
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r])) as Record<string, ActivityEntry>
    expect(byKind.vote).toMatchObject({ status: 'executed', txHash: '0xvote', gasEth: 0.001, podId: 'p1', direction: 'up' })
    expect(byKind.mint).toMatchObject({ status: 'executed', txHash: '0xmint', podId: '508', reppoSpent: 40 })
    expect(byKind.claim).toMatchObject({ status: 'executed', txHash: '0xclaim', reppoClaimed: 12.5, epoch: 101 })

    // --- SQL aggregates used by PnL agree with what we recorded ---
    expect(sumMintReppoSpent(dir)).toBe(40)
    expect(sumClaimedReppo(dir)).toBe(12.5)

    // --- Spend survives a fresh ledger reopened from the same on-disk DB ---
    const reopened = new BudgetLedger(dir, caps)
    expect(reopened.state.mintReppoSpent).toBe(40)
    expect(reopened.state.voteGasSpentEth).toBeCloseTo(0.001)
    expect(reopened.state.claimGasSpentEth).toBeCloseTo(0.0009)
  })

  it('a mint refused over the REPPO cap neither signs, spends, nor records an executed row', async () => {
    const ledger = new BudgetLedger(dir, { ...caps, mintReppoMax: 10 })
    ledger.startCycle('c1')
    const c = cli()
    const ex = new WalletExecutor(c, ledger)
    // est 0 → reserves the conservative 200 fallback, which exceeds the 10 cap → refuse pre-sign.
    const mint = await ex.executeMint({ kind: 'mint', datanetId: '9', subnetUuid: 'cm-9', canonicalKey: 'k1', podName: 'p', podDescription: 'd', datasetPath: '/tmp/x.json' })
    expect(mint.status).toBe('refused-budget')
    expect(c.mintPod).not.toHaveBeenCalled()
    expect(ledger.state.mintReppoSpent).toBe(0)
    // The cycle would record a refused-budget breadcrumb, not an executed mint — assert the
    // persisted PnL aggregate stays 0 (a refused row carries no reppoSpent).
    appendActivity(dir, rowFrom('mint', '9', mint, { canonicalKey: 'k1', podName: 'p' }))
    expect(sumMintReppoSpent(dir)).toBe(0)
    expect(readActivity(dir, { limit: 100 }).filter((r) => r.status === 'executed')).toHaveLength(0)
  })
})
