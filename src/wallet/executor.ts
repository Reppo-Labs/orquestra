// src/wallet/executor.ts
import { BudgetLedger } from './ledger.js'
import type { ReppoCli, LockArgs } from '../reppo/cli.js'
import type { VoteIntent, MintIntent, ClaimIntent, ExecResult } from './intents.js'

// Conservative pre-sign gas estimates; reconciled to actual after signing.
const VOTE_GAS_EST_ETH = 0.003
const MINT_GAS_EST_ETH = 0.02
const CLAIM_GAS_EST_ETH = 0.003

/** The only component that signs. Each public method reserves budget BEFORE
 *  signing (fail-closed), then reconciles to actual gas on success or
 *  releases the reservation on failure. */
export class WalletExecutor {
  constructor(private readonly cli: ReppoCli, private readonly ledger: BudgetLedger) {}

  /** One-time veREPPO lock for voting power. Not budget-gated. */
  async lock(args: LockArgs): Promise<ExecResult> {
    try {
      const r = await this.cli.lock(args)
      return { ok: true, status: 'executed', txHash: r.txHash }
    } catch (e) {
      return { ok: false, status: 'error', detail: (e as Error).message }
    }
  }

  async executeVote(intent: VoteIntent): Promise<ExecResult> {
    const res = this.ledger.reserveVote(VOTE_GAS_EST_ETH)
    if (!res) return { ok: false, status: 'refused-budget', detail: 'vote budget/rate exhausted' }
    try {
      const r = await this.cli.vote({ podId: intent.podId, direction: intent.direction, idempotencyKey: `vote-${intent.podId}-${intent.direction}` })
      if (!r.txHash) {
        this.ledger.releaseVote(res)
        return { ok: false, status: 'error', detail: 'no txHash' }
      }
      this.ledger.reconcileVote(res, r.gasEth)
      return { ok: true, status: 'executed', txHash: r.txHash, gasEth: r.gasEth }
    } catch (e) {
      this.ledger.releaseVote(res)
      return { ok: false, status: 'error', detail: (e as Error).message }
    }
  }

  async executeMint(intent: MintIntent): Promise<ExecResult> {
    const est = intent.estReppoCost ?? 0
    const res = this.ledger.reserveMint(est, MINT_GAS_EST_ETH)
    if (!res) return { ok: false, status: 'refused-budget', detail: 'mint budget exhausted' }
    try {
      const r = await this.cli.mintPod({
        datanetId: intent.datanetId, podName: intent.podName, podDescription: intent.podDescription,
        datasetPath: intent.datasetPath, idempotencyKey: `mint-${intent.canonicalKey}`,
      })
      if (!r.txHash) {
        this.ledger.releaseMint(res)
        return { ok: false, status: 'error', detail: 'no txHash' }
      }
      this.ledger.reconcileMint(res, r.gasEth)
      return { ok: true, status: 'executed', txHash: r.txHash, gasEth: r.gasEth }
    } catch (e) {
      this.ledger.releaseMint(res)
      return { ok: false, status: 'error', detail: (e as Error).message }
    }
  }

  async executeClaim(intent: ClaimIntent): Promise<ExecResult> {
    const res = this.ledger.reserveClaim(CLAIM_GAS_EST_ETH)
    if (!res) return { ok: false, status: 'refused-budget', detail: 'claim gas budget exhausted' }
    try {
      const r = await this.cli.claimEmissions({ podId: intent.podId, epoch: intent.epoch, idempotencyKey: intent.idempotencyKey })
      if (!r.txHash) {
        this.ledger.releaseClaim(res)
        return { ok: false, status: 'error', detail: 'no txHash' }
      }
      this.ledger.reconcileClaim(res, r.gasEth)
      return { ok: true, status: 'executed', txHash: r.txHash, gasEth: r.gasEth }
    } catch (e) {
      this.ledger.releaseClaim(res)
      return { ok: false, status: 'error', detail: (e as Error).message }
    }
  }
}
