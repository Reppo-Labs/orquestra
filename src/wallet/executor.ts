// src/wallet/executor.ts
import { BudgetLedger } from './ledger.js'
import type { ReppoCli, LockArgs } from '../reppo/cli.js'
import type { VoteIntent, MintIntent, ClaimIntent, ExecResult } from './intents.js'

// Conservative pre-sign gas estimates; reconciled to actual after signing.
const VOTE_GAS_EST_ETH = 0.003
const MINT_GAS_EST_ETH = 0.02
const CLAIM_GAS_EST_ETH = 0.003
/** Conservative mint-fee fallback (max observed: 200 REPPO) used only when the
 *  on-chain fee read fails — keeps the cap honest (over-count, never silent 0). */
export const MINT_REPPO_FALLBACK = 200

/** Reads the actual REPPO fee a landed mint tx charged the signer, or undefined
 *  if it can't be read. The reppo CLI omits the mint fee, so the executor reads
 *  it from the tx receipt to reconcile the ledger to real spend. */
export type ReppoFeeReader = (txHash: string) => Promise<number | undefined>

/** The only component that signs. Each public method reserves budget BEFORE
 *  signing (fail-closed), then reconciles to actual gas on success or
 *  releases the reservation on failure. */
export class WalletExecutor {
  constructor(
    private readonly cli: ReppoCli,
    private readonly ledger: BudgetLedger,
    /** When set, mint REPPO spend is reconciled to the on-chain fee (CLI omits it). */
    private readonly reppoFeeReader?: ReppoFeeReader,
    /** When set, the REPPO a claim actually paid is read from the tx receipt (CLI omits it),
     *  so the activity log / dashboard show real claimed amounts instead of 0. */
    private readonly claimReppoReader?: ReppoFeeReader,
  ) {}

  /** One-time veREPPO lock for voting power. Not budget-gated. */
  async lock(args: LockArgs): Promise<ExecResult> {
    try {
      const r = await this.cli.lock(args)
      return { ok: true, status: 'executed', txHash: r.txHash }
    } catch (e) {
      return { ok: false, status: 'error', detail: (e as Error).message }
    }
  }

  /** One-time per-subnet access grant (prerequisite for voting/minting). Like lock(),
   *  this is infrequent setup and not budget-gated: enabling a datanet is the operator's
   *  consent to pay its one-time, per-subnet, cached access fee (no grant budget cap).
   *  `token` selects the fee currency: 'reppo' (default, unchanged path) or 'primary'
   *  (pay in the datanet's primary token via reppo >=0.8.5; the cycle gates on the CLI
   *  version before passing 'primary' here). The fee amount is consent-bounded, not capped.
   *  SEAM: per-token mint fee cap (see 2026-06-15-non-reppo-access-fees-design.md §2.7) —
   *  grants are one-time/cached so they need no per-token cap; recurring NON-REPPO MINT
   *  spend would plug in at executeMint + the ledger, NOT here. Out of Phase 2 scope. */
  async executeGrantAccess(datanetId: string, token: 'reppo' | 'primary' = 'reppo'): Promise<ExecResult> {
    try {
      const r = await this.cli.grantAccess(datanetId, { token })
      if (!r.txHash) return { ok: false, status: 'error', detail: 'no txHash' }
      // Surface the actual fee paid (reppo >=0.8.5 reports feeAmount/feeToken on a
      // non-REPPO grant) so the cycle can show "paid 50 EXY" in the activity log. The
      // fee is consent-bounded (not budget-gated); this is informational only.
      return {
        ok: true, status: 'executed', txHash: r.txHash, gasEth: r.gasEth,
        ...(r.feeAmount !== undefined ? { feeAmount: r.feeAmount } : {}),
        ...(r.feePaid !== undefined ? { feePaid: r.feePaid } : {}),
        ...(r.feeToken ? { feeToken: r.feeToken } : {}),
      }
    } catch (e) {
      const detail = (e as Error).message
      // Already having access is success, not failure — report executed so the caller
      // caches it and stops re-attempting the grant every cycle (no fee was charged).
      if (/ACCESS_ALREADY_GRANTED/.test(detail)) return { ok: true, status: 'executed', detail: 'already granted' }
      // Every other CLI failure — including a primary-token INSUFFICIENT_TOKEN_BALANCE /
      // INSUFFICIENT_ALLOWANCE (the wallet isn't funded/approved for the fee token) — is a
      // recorded, non-fatal 'error': the cycle records it and skips THIS datanet (per-datanet
      // isolation), resuming once the operator funds the wallet. The node never crashes here
      // and never acquires the token itself.
      return { ok: false, status: 'error', detail }
    }
  }

  async executeVote(intent: VoteIntent): Promise<ExecResult> {
    const res = this.ledger.reserveVote(VOTE_GAS_EST_ETH)
    if (!res) return { ok: false, status: 'refused-budget', detail: 'vote budget/rate exhausted' }
    try {
      // Scale conviction (1-10) to 18-decimal veREPPO-power units. The on-chain vote() weights
      // curation in 18-decimal units; an unscaled conviction (e.g. 8 wei) is dust → ~0 share of
      // the pod's pool → 0 voter emissions. conviction × 1e18 spends 1-10 veREPPO-power per pod,
      // well within the wallet's locked power and giving real curation weight.
      const voteWeight = (BigInt(Math.max(1, Math.round(intent.conviction))) * 10n ** 18n).toString()
      const r = await this.cli.vote({ podId: intent.podId, direction: intent.direction, votes: voteWeight, idempotencyKey: `vote-${intent.podId}-${intent.direction}` })
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
    // Reserve a conservative REPPO estimate BEFORE signing so mintReppoMax is a true
    // pre-spend cap (refuse before, not after — the wallet invariant), mirroring the
    // grant path. The reppo CLI omits the mint fee, so the exact cost is unknown until
    // reconcile; reserve the max observed fee (MINT_REPPO_FALLBACK) and adjust DOWN to
    // the actual fee on success. An explicit estReppoCost (>0) overrides the default.
    const est = intent.estReppoCost || MINT_REPPO_FALLBACK
    const res = this.ledger.reserveMint(est, MINT_GAS_EST_ETH)
    if (!res) return { ok: false, status: 'refused-budget', detail: 'mint budget exhausted' }
    try {
      const r = await this.cli.mintPod({
        datanetId: intent.datanetId, subnetUuid: intent.subnetUuid, podName: intent.podName, podDescription: intent.podDescription,
        idempotencyKey: `mint-${intent.canonicalKey}`,
        ...(intent.datasetPath ? { datasetPath: intent.datasetPath } : {}),
        ...(intent.sourceUrl ? { url: intent.sourceUrl } : {}),
        ...(intent.imageUrl ? { imageUrl: intent.imageUrl } : {}),
      })
      if (!r.txHash) {
        this.ledger.releaseMint(res)
        return { ok: false, status: 'error', detail: 'no txHash' }
      }
      // Reconcile mintReppoSpent to the actual fee. Prefer the CLI value (>=0.8.4);
      // else read it from the tx receipt (requires RPC_URL); else KEEP the conservative
      // fallback. The last branch is critical: without RPC_URL the reader is absent, and
      // leaving the fee undefined would make reconcileMint a no-op that left spend at the
      // reserved estimate — but recording the fallback keeps mintReppoMax enforced rather
      // than silently blind. Over-count, never under-count.
      let reppoFee = r.reppoFee
      if (reppoFee === undefined && this.reppoFeeReader) {
        reppoFee = await this.reppoFeeReader(r.txHash)
      }
      if (reppoFee === undefined) {
        const why = this.reppoFeeReader ? 'receipt read failed' : 'no RPC_URL configured'
        console.warn(`orquestra: mint REPPO fee unknown for ${r.txHash} (${why}); recording conservative ${MINT_REPPO_FALLBACK} REPPO so mintReppoMax stays enforced`)
        reppoFee = MINT_REPPO_FALLBACK
      }
      this.ledger.reconcileMint(res, r.gasEth, reppoFee)
      return { ok: true, status: 'executed', txHash: r.txHash, gasEth: r.gasEth }
    } catch (e) {
      this.ledger.releaseMint(res)
      let detail = (e as Error).message
      // 0x5dd58b8b = TransferAmountExceedsBalance() (cast 4byte): the wallet lacks
      // liquid REPPO for the mint fee. Decode it so the activity log says why.
      if (/UNKNOWN_REVERT_0x5dd58b8b/.test(detail)) {
        detail += ' — decoded: TransferAmountExceedsBalance(): wallet lacks liquid REPPO for the mint fee'
      }
      return { ok: false, status: 'error', detail }
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
      // Read the actual REPPO claimed from the tx receipt (CLI/contract omit it) so the
      // activity log + dashboard show real amounts. Best-effort — undefined on read failure.
      const reppoClaimed = this.claimReppoReader ? await this.claimReppoReader(r.txHash) : undefined
      return { ok: true, status: 'executed', txHash: r.txHash, gasEth: r.gasEth, reppoClaimed }
    } catch (e) {
      this.ledger.releaseClaim(res)
      return { ok: false, status: 'error', detail: (e as Error).message }
    }
  }

  /** Claim the wallet's VOTER emissions for a (pod, epoch) it voted on. Identical budget /
   *  reconcile / receipt-amount handling to executeClaim, but routes to `claim-voter-emissions`
   *  (claimVoterEmissions on-chain) instead of the pod-owner claim. */
  async executeVoterClaim(intent: ClaimIntent): Promise<ExecResult> {
    const res = this.ledger.reserveClaim(CLAIM_GAS_EST_ETH)
    if (!res) return { ok: false, status: 'refused-budget', detail: 'claim gas budget exhausted' }
    try {
      const r = await this.cli.claimVoterEmissions({ podId: intent.podId, epoch: intent.epoch, idempotencyKey: intent.idempotencyKey })
      if (!r.txHash) {
        this.ledger.releaseClaim(res)
        return { ok: false, status: 'error', detail: 'no txHash' }
      }
      this.ledger.reconcileClaim(res, r.gasEth)
      const reppoClaimed = this.claimReppoReader ? await this.claimReppoReader(r.txHash) : undefined
      return { ok: true, status: 'executed', txHash: r.txHash, gasEth: r.gasEth, reppoClaimed }
    } catch (e) {
      this.ledger.releaseClaim(res)
      return { ok: false, status: 'error', detail: (e as Error).message }
    }
  }
}
