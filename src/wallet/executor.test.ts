// src/wallet/executor.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BudgetLedger } from './ledger.js'
import { WalletExecutor } from './executor.js'
import type { ReppoCli } from '../reppo/cli.js'
import type { VoteIntent, MintIntent } from './intents.js'

const caps = { voteGasEthMax: 0.05, voteRateMaxPerCycle: 2, mintReppoMax: 100, mintGasEthMax: 0.1 }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-exec-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const fakeCli = (): ReppoCli => ({
  lock: vi.fn(async () => ({ txHash: '0xlock', gasEth: 0.002 })),
  vote: vi.fn(async () => ({ txHash: '0xvote', gasEth: 0.001 })),
  mintPod: vi.fn(async () => ({ txHash: '0xmint', gasEth: 0.01 })),
})
const voteIntent = (podId: string): VoteIntent => ({ kind: 'vote', datanetId: '9', podId, direction: 'up', conviction: 9, reason: 'aligned' })
const mintIntent = (key: string, est = 0): MintIntent => ({ kind: 'mint', datanetId: '9', canonicalKey: key, podName: 'p', podDescription: 'd', datasetPath: '/tmp/x.json', estReppoCost: est })

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

  it('executes a mint within budget and records REPPO + gas', async () => {
    const cli = fakeCli(); const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    const r = await ex.executeMint(mintIntent('k1', 50))
    expect(r.status).toBe('executed')
    expect(ledger.state.mintReppoSpent).toBe(50)
    expect(ledger.state.mintGasSpentEth).toBeCloseTo(0.01)
  })

  it('reports error (not executed) when the CLI throws, and does not record spend', async () => {
    const cli = fakeCli(); (cli.vote as any) = vi.fn(async () => { throw new Error('rpc down') })
    const ledger = new BudgetLedger(dir, caps); ledger.startCycle('c1')
    const ex = new WalletExecutor(cli, ledger)
    const r = await ex.executeVote(voteIntent('p1'))
    expect(r.status).toBe('error')
    expect(ledger.state.votesCastThisCycle).toBe(0)
  })
})
