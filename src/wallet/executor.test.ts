// src/wallet/executor.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BudgetLedger } from './ledger.js'
import { WalletExecutor, MINT_REPPO_FALLBACK } from './executor.js'
import type { ReppoCli } from '../reppo/cli.js'
import type { VoteIntent, MintIntent, ClaimIntent } from './intents.js'

const caps = { voteGasEthMax: 0.05, voteRateMaxPerCycle: 2, mintReppoMax: 100, mintGasEthMax: 0.1, claimGasEthMax: 0.05 }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-exec-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const fakeCli = (): ReppoCli => ({
  lock: vi.fn(async () => ({ txHash: '0xlock', gasEth: 0.002 })),
  vote: vi.fn(async () => ({ txHash: '0xvote', gasEth: 0.001 })),
  mintPod: vi.fn(async () => ({ txHash: '0xmint', gasEth: 0.01 })),
  claimEmissions: vi.fn(async () => ({ txHash: '0xclaim', gasEth: 0.0009 })),
  claimVoterEmissions: vi.fn(async () => ({ txHash: '0xvclaim', gasEth: 0.0009 })),
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
    // conviction 9 → vote weight scaled to 18 decimals (9e18), NOT raw 9 (which votes dust → 0 emissions)
    expect((cli.vote as ReturnType<typeof vi.fn>).mock.calls[0][0].votes).toBe('9000000000000000000')
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
    const reader = vi.fn(async () => 50) // mint-pod tx paid 50 REPPO on-chain
    const ex = new WalletExecutor(cli, ledger, reader)
    const r = await ex.executeMint(mintIntent('k1', 50))
    expect(r.status).toBe('executed')
    expect(ledger.state.mintReppoSpent).toBe(50)
    // actual gas returned by fakeCli is 0.01; reconcileMint adjusts from MINT_GAS_EST_ETH (0.02)
    expect(ledger.state.mintGasSpentEth).toBeCloseTo(0.01)
  })

  it('reconciles mint REPPO to the on-chain fee read from the receipt (CLI omits it)', async () => {
    // est defaults to 0 → reserve the conservative MINT_REPPO_FALLBACK (200) pre-sign,
    // so the cap must accommodate it; reconcile DOWN to the actual 150.
    const cli = fakeCli(); const ledger = new BudgetLedger(dir, { ...caps, mintReppoMax: 500 }); ledger.startCycle('c1')
    const reader = vi.fn(async () => 150) // mint-pod tx paid 150 REPPO on-chain
    const ex = new WalletExecutor(cli, ledger, reader)
    await ex.executeMint(mintIntent('k1'))
    expect(reader).toHaveBeenCalledWith('0xmint')
    expect(ledger.state.mintReppoSpent).toBe(150)
  })

  it('falls back to a conservative REPPO estimate when the fee read fails (never under-counts to 0)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cli = fakeCli(); const ledger = new BudgetLedger(dir, { ...caps, mintReppoMax: 500 }); ledger.startCycle('c1')
    const reader = vi.fn(async () => undefined) // RPC down / reverted — no fee read
    const ex = new WalletExecutor(cli, ledger, reader)
    await ex.executeMint(mintIntent('k1'))
    expect(ledger.state.mintReppoSpent).toBe(MINT_REPPO_FALLBACK)
    warn.mockRestore()
  })

  it('CRITICAL: with NO fee reader (RPC_URL unset) a mint still records the conservative fee, not 0 — mintReppoMax stays enforced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cli = fakeCli(); const ledger = new BudgetLedger(dir, { ...caps, mintReppoMax: 500 }); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger) // no reppoFeeReader — the documented default config
    await ex.executeMint(mintIntent('k1'))
    // Before the fix this stayed at the reserved 0 forever, leaving the REPPO cap a no-op.
    expect(ledger.state.mintReppoSpent).toBe(MINT_REPPO_FALLBACK)
    warn.mockRestore()
  })

  it('refuses a mint pre-sign when mintReppoMax is below one conservative fee (fail-closed, no CLI call)', async () => {
    const cli = fakeCli(); const ledger = new BudgetLedger(dir, { ...caps, mintReppoMax: 0 }); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    const r = await ex.executeMint(mintIntent('k1')) // est 0 → reserve MINT_REPPO_FALLBACK > 0 cap
    expect(r.status).toBe('refused-budget')
    expect(cli.mintPod).not.toHaveBeenCalled()
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
        const persisted = new BudgetLedger(dir, caps).state   // reads the committed row from the DB
        countSeenByCli = persisted.votesCastThisCycle
        return { txHash: '0xvote', gasEth: 0.001 }
      }),
      mintPod: vi.fn(async () => ({ txHash: '0xmint', gasEth: 0 })),
      claimEmissions: vi.fn(async () => ({ txHash: '0xclaim', gasEth: 0 })),
      claimVoterEmissions: vi.fn(async () => ({ txHash: '0xvclaim', gasEth: 0 })),
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
        const persisted = new BudgetLedger(dir, caps).state   // reads the committed row from the DB
        reppoSeenByCli = persisted.mintReppoSpent
        return { txHash: '0xmint', gasEth: 0.01 }
      }),
      claimEmissions: vi.fn(async () => ({ txHash: '0xclaim', gasEth: 0 })),
      claimVoterEmissions: vi.fn(async () => ({ txHash: '0xvclaim', gasEth: 0 })),
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

  it('executeGrantAccess returns executed and passes the subnet id (default reppo token)', async () => {
    const cli = fakeCli(); const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const r = await new WalletExecutor(cli, ledger).executeGrantAccess('cm-subnet-9')
    expect(r.status).toBe('executed')
    expect(r.txHash).toBe('0xgrant')
    expect(cli.grantAccess).toHaveBeenCalledWith('cm-subnet-9', { token: 'reppo' })
  })

  it('executeGrantAccess passes token=primary through to the CLI for a non-REPPO fee', async () => {
    const cli = fakeCli(); const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const r = await new WalletExecutor(cli, ledger).executeGrantAccess('42', 'primary')
    expect(r.status).toBe('executed')
    expect(cli.grantAccess).toHaveBeenCalledWith('42', { token: 'primary' })
  })

  it('executeGrantAccess records INSUFFICIENT_TOKEN_BALANCE as a non-fatal error (not a crash)', async () => {
    const cli = fakeCli()
    ;(cli.grantAccess as any) = vi.fn(async () => { throw new Error('grant-access failed: INSUFFICIENT_TOKEN_BALANCE') })
    const r = await new WalletExecutor(cli, new BudgetLedger(dir, caps)).executeGrantAccess('42', 'primary')
    expect(r.status).toBe('error')
    expect(r.detail).toMatch(/INSUFFICIENT_TOKEN_BALANCE/)
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
})

const CLAIM_CAPS: typeof caps = { voteGasEthMax: 0.05, voteRateMaxPerCycle: 30, mintReppoMax: 500, mintGasEthMax: 0.05, claimGasEthMax: 0.05 }
const claimIntent = (over: Partial<ClaimIntent> = {}): ClaimIntent => ({ kind: 'claim', datanetId: '9', podId: '1', epoch: 101, reppoDue: 12.5, idempotencyKey: 'claim-1-101', ...over })

const fakeClaimCli = (over: Partial<ReppoCli> = {}): ReppoCli => ({
  lock: async () => ({ txHash: '0xlock', gasEth: 0 }),
  vote: async () => ({ txHash: '0xvote', gasEth: 0.001 }),
  mintPod: async () => ({ txHash: '0xmint', gasEth: 0.01 }),
  claimEmissions: async () => ({ txHash: '0xclaim', gasEth: 0.0009 }),
  claimVoterEmissions: async () => ({ txHash: '0xvclaim', gasEth: 0.0009 }),
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

  it('executeVoterClaim routes to claimVoterEmissions and reconciles gas', async () => {
    const ledger = new BudgetLedger(dir, CLAIM_CAPS)
    const voterCli = vi.fn(async () => ({ txHash: '0xvclaim', gasEth: 0.0009 }))
    const ownerCli = vi.fn(async () => ({ txHash: '0xclaim', gasEth: 0.0009 }))
    const ex = new WalletExecutor(fakeClaimCli({ claimVoterEmissions: voterCli, claimEmissions: ownerCli }), ledger)
    const r = await ex.executeVoterClaim(claimIntent())
    expect(r.status).toBe('executed')
    expect(r.txHash).toBe('0xvclaim')
    expect(voterCli).toHaveBeenCalledTimes(1)   // voter path
    expect(ownerCli).not.toHaveBeenCalled()     // NOT the owner path
    expect(ledger.state.claimGasSpentEth).toBeCloseTo(0.0009)
  })

  it('executeVoterClaim refuses when the claim gas cap is exhausted', async () => {
    const ledger = new BudgetLedger(dir, { ...CLAIM_CAPS, claimGasEthMax: 0 })
    const ex = new WalletExecutor(fakeClaimCli(), ledger)
    const r = await ex.executeVoterClaim(claimIntent())
    expect(r.status).toBe('refused-budget')
  })

  it('reads the NON-REPPO token amount from the claim receipt when the intent carries a token', async () => {
    const ledger = new BudgetLedger(dir, CLAIM_CAPS)
    const reppoReader = vi.fn(async () => 0)            // zero REPPO for a native-only datanet
    const tokenReader = vi.fn(async () => 40000)        // 40,000 LBM landed
    const ex = new WalletExecutor(fakeClaimCli(), ledger, undefined, reppoReader, tokenReader)
    const token = { address: '0x15B15FA54b629C634958E8BD639b2fc8af654974', symbol: 'LBM', decimals: 18 }
    const r = await ex.executeVoterClaim(claimIntent({ token }))
    expect(r.status).toBe('executed')
    expect(r.tokenClaimed).toEqual({ symbol: 'LBM', amount: 40000 })
    expect(tokenReader).toHaveBeenCalledWith('0xvclaim', token.address, 18)
  })

  it('leaves tokenClaimed undefined for a plain REPPO claim (no intent.token)', async () => {
    const ledger = new BudgetLedger(dir, CLAIM_CAPS)
    const tokenReader = vi.fn(async () => 40000)
    const ex = new WalletExecutor(fakeClaimCli(), ledger, undefined, vi.fn(async () => 12.5), tokenReader)
    const r = await ex.executeClaim(claimIntent())
    expect(r.status).toBe('executed')
    expect(r.tokenClaimed).toBeUndefined()
    expect(tokenReader).not.toHaveBeenCalled()
  })

  it('surfaces gasEth on vote results too', async () => {
    const ledger = new BudgetLedger(dir, CLAIM_CAPS)
    ledger.startCycle('c1')
    const ex = new WalletExecutor(fakeClaimCli(), ledger)
    const r = await ex.executeVote({ kind: 'vote', datanetId: '9', podId: '1', direction: 'up', conviction: 9, reason: 'r' })
    expect(r.gasEth).toBeCloseTo(0.001)
  })
})

describe('actual-REPPO reconciliation (reppoFee from CLI >=0.8.4)', () => {
  it('executeMint reconciles mintReppoSpent to the actual fee', async () => {
    const cli = fakeCli()
    ;(cli.mintPod as any) = vi.fn(async () => ({ txHash: '0xm', gasEth: 0.0005, reppoFee: 100 }))
    const ledger = new BudgetLedger(dir, { ...caps, mintReppoMax: 500 }); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    await ex.executeMint(mintIntent('k1', 0))   // est 0, actual 100
    expect(ledger.state.mintReppoSpent).toBe(100)
  })
})
