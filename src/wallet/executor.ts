// src/wallet/executor.ts
import { BudgetLedger } from './ledger.js'
import type { ReppoCli, LockArgs } from '../reppo/cli.js'
import type { VoteIntent, MintIntent, ExecResult } from './intents.js'

/** The only component that signs. Each public method checks the ledger first,
 *  calls the CLI only if affordable, then records spend (which persists). */
export class WalletExecutor {
  constructor(private readonly cli: ReppoCli, private readonly ledger: BudgetLedger) {}

  /** One-time veREPPO lock for voting power. */
  async lock(args: LockArgs): Promise<ExecResult> {
    try {
      const r = await this.cli.lock(args)
      return { ok: true, status: 'executed', txHash: r.txHash }
    } catch (e) {
      return { ok: false, status: 'error', detail: (e as Error).message }
    }
  }

  async executeVote(intent: VoteIntent): Promise<ExecResult> {
    if (!this.ledger.canVote()) return { ok: false, status: 'refused-budget', detail: 'vote budget/rate exhausted' }
    try {
      const r = await this.cli.vote({ podId: intent.podId, direction: intent.direction, idempotencyKey: `vote-${intent.podId}-${intent.direction}` })
      this.ledger.recordVote(r.gasEth)
      return { ok: true, status: 'executed', txHash: r.txHash }
    } catch (e) {
      return { ok: false, status: 'error', detail: (e as Error).message }
    }
  }

  async executeMint(intent: MintIntent): Promise<ExecResult> {
    const est = intent.estReppoCost ?? 0
    if (!this.ledger.canMint(est)) return { ok: false, status: 'refused-budget', detail: 'mint budget exhausted' }
    try {
      const r = await this.cli.mintPod({
        datanetId: intent.datanetId, podName: intent.podName, podDescription: intent.podDescription,
        datasetPath: intent.datasetPath, idempotencyKey: `mint-${intent.canonicalKey}`,
      })
      this.ledger.recordMint(est, r.gasEth)
      return { ok: true, status: 'executed', txHash: r.txHash }
    } catch (e) {
      return { ok: false, status: 'error', detail: (e as Error).message }
    }
  }
}
