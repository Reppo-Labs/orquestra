// src/wallet/executor.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BudgetLedger } from './ledger.js'
import { WalletExecutor } from './executor.js'
import type { ReppoCli } from '../reppo/cli.js'
import type { VoteIntent, MintIntent, ClaimIntent } from './intents.js'

const caps = { voteGasEthMax: 0.05, voteRateMaxPerCycle: 2, mintReppoMax: 100, mintGasEthMax: 0.1, claimGasEthMax: 0.05, grantReppoMax: 500 }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-exec-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const fakeCli = (): ReppoCli => ({
  lock: vi.fn(async () => ({ txHash: '0xlock', gasEth: 0.002 })),
  vote: vi.fn(async () => ({ txHash: '0xvote', gasEth: 0.001 })),
  mintPod: vi.fn(async () => ({ txHash: '0xmint', gasEth: 0.01 })),
  claimEmissions: vi.fn(async () => ({ txHash: '0xclaim', gasEth: 0.0009 })),
  grantAccess: vi.fn(async () => ({ txHash: '0xgrant', gasEth: 0.0005 })),
})
const voteIntent = (podId: string): VoteIntent => ({ kind: 'vote', datanetId: '9', podId, direction: 'up', conviction: 9, reason: 'aligned' })
const mintIntent = (key: string, est = 0): MintIntent => ({ kind: 'mint', datanetId: '9', subnetUuid: 'cm-subnet-9', canonicalKey: key, podName: 'p', podDescription: 'd', datasetPath: '/tmp/x.json', estReppoCost: est })

describe('WalletExecutor', () => {
  it('executes a vote within budget and records it', async () => {
    const cli = fakeCli(); const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    const r = await ex.executeVote(voteIntent('p1'))
    expect(r.status).toBe('executed')
    expect(r.txHash).toBe('0xvote')
    expect(cli.vote).toHaveBeenCalledOnce()
    expect(ledger.state.votesCastThisCycle).toBe(1)
  })

  it('refuses a vote over the per-cycle cap WITHOUT calling the CLI', async () => {
    const cli = fakeCli(); const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    await ex.executeVote(voteIntent('p1'))
    await ex.executeVote(voteIntent('p2')) // 2 = cap
    const r = await ex.executeVote(voteIntent('p3'))
    expect(r.status).toBe('refused-budget')
    expect(cli.vote).toHaveBeenCalledTimes(2) // p3 never signed
  })

  it('refuses a mint over the REPPO cap WITHOUT calling the CLI', async () => {
    const cli = fakeCli(); const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    const r = await ex.executeMint(mintIntent('k1', 150)) // 150 > 100 cap
    expect(r.status).toBe('refused-budget')
    expect(cli.mintPod).not.toHaveBeenCalled()
  })

  it('executes a mint within budget and reconciles REPPO + actual gas', async () => {
    const cli = fakeCli(); const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    const r = await ex.executeMint(mintIntent('k1', 50))
    expect(r.status).toBe('executed')
    expect(ledger.state.mintReppoSpent).toBe(50)
    // actual gas returned by fakeCli is 0.01; reconcileMint adjusts from MINT_GAS_EST_ETH (0.02)
    expect(ledger.state.mintGasSpentEth).toBeCloseTo(0.01)
  })

  it('reports error (not executed) when the CLI throws, and reservation is released', async () => {
    const cli = fakeCli(); (cli.vote as any) = vi.fn(async () => { throw new Error('rpc down') })
    const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    const r = await ex.executeVote(voteIntent('p1'))
    expect(r.status).toBe('error')
    expect(ledger.state.votesCastThisCycle).toBe(0)
    expect(ledger.state.voteGasSpentEth).toBeCloseTo(0)
  })

  // --- crash-safety: reserve is persisted before CLI is called ---

  it('crash-safety: vote reserve is persisted on disk before CLI is called', async () => {
    const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')

    // CLI impl reads the ledger file from disk and verifies the debit is already there
    let countSeenByCli = -1
    const cli: ReppoCli = {
      lock: vi.fn(async () => ({ txHash: '0xlock', gasEth: 0 })),
      vote: vi.fn(async () => {
        const persisted = JSON.parse(readFileSync(join(dir, 'budget-ledger.json'), 'utf-8'))
        countSeenByCli = persisted.votesCastThisCycle
        return { txHash: '0xvote', gasEth: 0.001 }
      }),
      mintPod: vi.fn(async () => ({ txHash: '0xmint', gasEth: 0 })),
      claimEmissions: vi.fn(async () => ({ txHash: '0xclaim', gasEth: 0 })),
      grantAccess: vi.fn(async () => ({ txHash: '0xgrant', gasEth: 0 })),
    }

    const ex = new WalletExecutor(cli, ledger)
    await ex.executeVote(voteIntent('p1'))
    // The CLI saw the debit already committed on disk
    expect(countSeenByCli).toBe(1)
  })

  it('crash-safety: mint reserve is persisted on disk before CLI is called', async () => {
    const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')

    let reppoSeenByCli = -1
    const cli: ReppoCli = {
      lock: vi.fn(async () => ({ txHash: '0xlock', gasEth: 0 })),
      vote: vi.fn(async () => ({ txHash: '0xvote', gasEth: 0 })),
      mintPod: vi.fn(async () => {
        const persisted = JSON.parse(readFileSync(join(dir, 'budget-ledger.json'), 'utf-8'))
        reppoSeenByCli = persisted.mintReppoSpent
        return { txHash: '0xmint', gasEth: 0.01 }
      }),
      claimEmissions: vi.fn(async () => ({ txHash: '0xclaim', gasEth: 0 })),
      grantAccess: vi.fn(async () => ({ txHash: '0xgrant', gasEth: 0 })),
    }

    const ex = new WalletExecutor(cli, ledger)
    await ex.executeMint(mintIntent('k1', 50))
    expect(reppoSeenByCli).toBe(50)
  })

  // --- error path: reservation is released ---

  it('error path: vote reservation is released when CLI throws', async () => {
    const cli = fakeCli()
    ;(cli.vote as any) = vi.fn(async () => { throw new Error('network error') })
    const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    const r = await ex.executeVote(voteIntent('p1'))
    expect(r.status).toBe('error')
    expect(ledger.state.votesCastThisCycle).toBe(0)
    expect(ledger.state.voteGasSpentEth).toBeCloseTo(0)
  })

  it('error path: mint reservation is released when CLI throws', async () => {
    const cli = fakeCli()
    ;(cli.mintPod as any) = vi.fn(async () => { throw new Error('network error') })
    const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    const r = await ex.executeMint(mintIntent('k1', 50))
    expect(r.status).toBe('error')
    expect(ledger.state.mintReppoSpent).toBe(0)
    expect(ledger.state.mintGasSpentEth).toBeCloseTo(0)
  })

  it('decodes the 0x5dd58b8b mint revert into a readable hint', async () => {
    const cli = fakeCli()
    ;(cli.mintPod as any) = vi.fn(async () => { throw new Error('mint-pod tx failed: UNKNOWN_REVERT_0x5dd58b8b') })
    const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    const r = await ex.executeMint(mintIntent('k1', 50))
    expect(r.status).toBe('error')
    expect(r.detail).toMatch(/TransferAmountExceedsBalance/)
    expect(r.detail).toMatch(/lacks liquid REPPO/)
  })

  // --- empty txHash: treat as error and release reservation ---

  it('empty txHash on vote returns status=error and releases reservation', async () => {
    const cli = fakeCli()
    ;(cli.vote as any) = vi.fn(async () => ({ txHash: '', gasEth: 0.001 }))
    const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    const r = await ex.executeVote(voteIntent('p1'))
    expect(r.status).toBe('error')
    expect(r.detail).toBe('no txHash')
    // reservation released
    expect(ledger.state.votesCastThisCycle).toBe(0)
  })

  it('empty txHash on mint returns status=error and releases reservation', async () => {
    const cli = fakeCli()
    ;(cli.mintPod as any) = vi.fn(async () => ({ txHash: '', gasEth: 0.01 }))
    const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    const r = await ex.executeMint(mintIntent('k1', 50))
    expect(r.status).toBe('error')
    expect(r.detail).toBe('no txHash')
    expect(ledger.state.mintReppoSpent).toBe(0)
  })

  it('executeGrantAccess returns executed and passes the subnet id', async () => {
    const cli = fakeCli(); const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const r = await new WalletExecutor(cli, ledger).executeGrantAccess('cm-subnet-9')
    expect(r.status).toBe('executed')
    expect(r.txHash).toBe('0xgrant')
    expect(cli.grantAccess).toHaveBeenCalledWith('cm-subnet-9')
  })

  it('executeGrantAccess returns error when the CLI throws (no access yet)', async () => {
    const cli = fakeCli()
    ;(cli.grantAccess as any) = vi.fn(async () => { throw new Error('VOTER_LACKS_SUBNET_ACCESS') })
    const r = await new WalletExecutor(cli, new BudgetLedger(dir, caps)).executeGrantAccess('cm-subnet-9')
    expect(r.status).toBe('error')
    expect(r.detail).toMatch(/VOTER_LACKS_SUBNET_ACCESS/)
  })

  it('executeGrantAccess treats ACCESS_ALREADY_GRANTED as executed (so it caches, not re-pays)', async () => {
    const cli = fakeCli()
    ;(cli.grantAccess as any) = vi.fn(async () => { throw new Error('Command failed — {"error":{"code":"ACCESS_ALREADY_GRANTED"}}') })
    const r = await new WalletExecutor(cli, new BudgetLedger(dir, caps)).executeGrantAccess('9')
    expect(r.status).toBe('executed')
    expect(r.detail).toBe('already granted')
  })

  it('executeGrantAccess refuses (no CLI call) when grantReppoMax is 0 — grants are opt-in', async () => {
    const cli = fakeCli()
    const ledger = new BudgetLedger(dir, { ...caps, grantReppoMax: 0 })
    const r = await new WalletExecutor(cli, ledger).executeGrantAccess('9')
    expect(r.status).toBe('refused-budget')
    expect(cli.grantAccess).not.toHaveBeenCalled()
  })

  it('executeGrantAccess releases the REPPO reservation when the grant fails (no spend leaks)', async () => {
    const cli = fakeCli()
    ;(cli.grantAccess as any) = vi.fn(async () => { throw new Error('INSUFFICIENT_REPPO_BALANCE') })
    const ledger = new BudgetLedger(dir, caps)
    const r = await new WalletExecutor(cli, ledger).executeGrantAccess('9')
    expect(r.status).toBe('error')
    expect(ledger.state.grantReppoSpent).toBeCloseTo(0)
  })
})

const CLAIM_CAPS: typeof caps = { voteGasEthMax: 0.05, voteRateMaxPerCycle: 30, mintReppoMax: 500, mintGasEthMax: 0.05, claimGasEthMax: 0.05, grantReppoMax: 500 }
const claimIntent = (over: Partial<ClaimIntent> = {}): ClaimIntent => ({ kind: 'claim', datanetId: '9', podId: '1', epoch: 101, reppoDue: 12.5, idempotencyKey: 'claim-1-101', ...over })

const fakeClaimCli = (over: Partial<ReppoCli> = {}): ReppoCli => ({
  lock: async () => ({ txHash: '0xlock', gasEth: 0 }),
  vote: async () => ({ txHash: '0xvote', gasEth: 0.001 }),
  mintPod: async () => ({ txHash: '0xmint', gasEth: 0.01 }),
  claimEmissions: async () => ({ txHash: '0xclaim', gasEth: 0.0009 }),
  grantAccess: async () => ({ txHash: '0xgrant', gasEth: 0.0005 }),
  ...over,
})

describe('WalletExecutor.executeClaim', () => {
  it('claims, reconciles gas, returns txHash + gasEth', async () => {
    const ledger = new BudgetLedger(dir, CLAIM_CAPS)
    const ex = new WalletExecutor(fakeClaimCli(), ledger)
    const r = await ex.executeClaim(claimIntent())
    expect(r.status).toBe('executed')
    expect(r.txHash).toBe('0xclaim')
    expect(r.gasEth).toBeCloseTo(0.0009)
    expect(ledger.state.claimGasSpentEth).toBeCloseTo(0.0009)
  })

  it('refuses when the claim gas cap is exhausted', async () => {
    const ledger = new BudgetLedger(dir, { ...CLAIM_CAPS, claimGasEthMax: 0 })
    const ex = new WalletExecutor(fakeClaimCli(), ledger)
    const r = await ex.executeClaim(claimIntent())
    expect(r.status).toBe('refused-budget')
  })

  it('releases the reservation when the CLI throws', async () => {
    const ledger = new BudgetLedger(dir, CLAIM_CAPS)
    const ex = new WalletExecutor(fakeClaimCli({ claimEmissions: async () => { throw new Error('rpc down') } }), ledger)
    const r = await ex.executeClaim(claimIntent())
    expect(r.status).toBe('error')
    expect(ledger.state.claimGasSpentEth).toBeCloseTo(0)
  })

  it('surfaces gasEth on vote results too', async () => {
    const ledger = new BudgetLedger(dir, CLAIM_CAPS)
    ledger.startCycle('c1')
    const ex = new WalletExecutor(fakeClaimCli(), ledger)
    const r = await ex.executeVote({ kind: 'vote', datanetId: '9', podId: '1', direction: 'up', conviction: 9, reason: 'r' })
    expect(r.gasEth).toBeCloseTo(0.001)
  })
})
