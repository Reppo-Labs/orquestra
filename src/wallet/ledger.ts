// src/wallet/ledger.ts
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export interface BudgetCaps {
  voteGasEthMax: number
  voteRateMaxPerCycle: number
  mintReppoMax: number
  mintGasEthMax: number
  claimGasEthMax: number
}

export interface LedgerState {
  cycleId: string
  votesCastThisCycle: number
  voteGasSpentEth: number // cumulative over horizon
  mintReppoSpent: number // cumulative
  mintGasSpentEth: number // cumulative
  claimGasSpentEth: number // cumulative
}

export interface VoteReservation {
  kind: 'vote'
  estGasEth: number
}

export interface MintReservation {
  kind: 'mint'
  estReppo: number
  estGasEth: number
}

export interface ClaimReservation {
  kind: 'claim'
  estGasEth: number
}

/** Thrown when the persisted ledger file exists but is corrupt or invalid.
 *  Fail-closed: the process must not continue with an unknown spend state. */
export class LedgerCorruptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerCorruptError'
  }
}

const LEDGER_FILE = 'budget-ledger.json'

const nonNegativeFinite = z.number().finite().nonnegative()

const LedgerSchema = z.object({
  cycleId: z.string(),
  votesCastThisCycle: nonNegativeFinite,
  voteGasSpentEth: nonNegativeFinite,
  mintReppoSpent: nonNegativeFinite,
  mintGasSpentEth: nonNegativeFinite,
  claimGasSpentEth: nonNegativeFinite.default(0),
})

const fresh = (): LedgerState => ({
  cycleId: '', votesCastThisCycle: 0, voteGasSpentEth: 0, mintReppoSpent: 0, mintGasSpentEth: 0, claimGasSpentEth: 0,
})

/** Persisted per-pool budget enforcement. The ONLY authority on whether an
 *  action is affordable. All caps are hard: at the cap, the action is refused.
 *
 *  Crash-safety: reserve* debits and persists BEFORE the caller signs.
 *  A crash after reserve leaves the spend counted (conservative over-count,
 *  never under-count). reconcile* adjusts to the actual gas; release* rolls
 *  back when signing fails. */
export class BudgetLedger {
  private _state: LedgerState

  constructor(private readonly dataDir: string, private readonly caps: BudgetCaps) {
    const path = join(dataDir, LEDGER_FILE)
    if (existsSync(path)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(path, 'utf-8'))
      } catch (e) {
        throw new LedgerCorruptError(`budget-ledger.json is not valid JSON: ${(e as Error).message}`)
      }
      const result = LedgerSchema.safeParse(parsed)
      if (!result.success) {
        throw new LedgerCorruptError(`budget-ledger.json failed validation: ${result.error.message}`)
      }
      this._state = result.data
    } else {
      this._state = fresh()
    }
  }

  /** Returns a frozen copy of the current ledger state. */
  get state(): Readonly<LedgerState> {
    return Object.freeze({ ...this._state })
  }

  /** Reset per-cycle counters when entering a new cycle. Cumulative totals persist. */
  startCycle(cycleId: string): void {
    if (cycleId !== this._state.cycleId) {
      this._state.cycleId = cycleId
      this._state.votesCastThisCycle = 0
      this.save()
    }
  }

  canVote(): boolean {
    return this._state.votesCastThisCycle < this.caps.voteRateMaxPerCycle
      && this._state.voteGasSpentEth < this.caps.voteGasEthMax
  }

  canMint(estReppoCost: number): boolean {
    return this._state.mintReppoSpent + estReppoCost <= this.caps.mintReppoMax
      && this._state.mintGasSpentEth < this.caps.mintGasEthMax
  }

  /** Debit and persist BEFORE signing. Returns null if over budget (no debit). */
  reserveVote(estGasEth: number): VoteReservation | null {
    if (!this.canVote()) return null
    this._state.votesCastThisCycle += 1
    this._state.voteGasSpentEth += estGasEth
    this.save()
    return { kind: 'vote', estGasEth }
  }

  /** Adjust gas to actual after a successful sign. */
  reconcileVote(res: VoteReservation, actualGasEth: number): void {
    this._state.voteGasSpentEth += (actualGasEth - res.estGasEth)
    this._state.voteGasSpentEth = Math.max(0, this._state.voteGasSpentEth)
    this.save()
  }

  /** Roll back the reservation when signing fails. */
  releaseVote(res: VoteReservation): void {
    this._state.votesCastThisCycle = Math.max(0, this._state.votesCastThisCycle - 1)
    this._state.voteGasSpentEth = Math.max(0, this._state.voteGasSpentEth - res.estGasEth)
    this.save()
  }

  /** Debit and persist BEFORE signing. Returns null if over budget (no debit). */
  reserveMint(estReppo: number, estGasEth: number): MintReservation | null {
    if (!this.canMint(estReppo)) return null
    this._state.mintReppoSpent += estReppo
    this._state.mintGasSpentEth += estGasEth
    this.save()
    return { kind: 'mint', estReppo, estGasEth }
  }

  /** Adjust gas to actual after a successful sign. */
  reconcileMint(res: MintReservation, actualGasEth: number): void {
    this._state.mintGasSpentEth += (actualGasEth - res.estGasEth)
    this._state.mintGasSpentEth = Math.max(0, this._state.mintGasSpentEth)
    this.save()
  }

  /** Roll back the reservation when signing fails. */
  releaseMint(res: MintReservation): void {
    this._state.mintReppoSpent = Math.max(0, this._state.mintReppoSpent - res.estReppo)
    this._state.mintGasSpentEth = Math.max(0, this._state.mintGasSpentEth - res.estGasEth)
    this.save()
  }

  canClaim(estGasEth: number): boolean {
    return this._state.claimGasSpentEth + estGasEth <= this.caps.claimGasEthMax
  }

  /** Debit and persist BEFORE signing. Returns null if over the gas cap (no debit). */
  reserveClaim(estGasEth: number): ClaimReservation | null {
    if (!this.canClaim(estGasEth)) return null
    this._state.claimGasSpentEth += estGasEth
    this.save()
    return { kind: 'claim', estGasEth }
  }

  /** Adjust gas to actual after a successful sign. */
  reconcileClaim(res: ClaimReservation, actualGasEth: number): void {
    this._state.claimGasSpentEth += (actualGasEth - res.estGasEth)
    this._state.claimGasSpentEth = Math.max(0, this._state.claimGasSpentEth)
    this.save()
  }

  /** Roll back the reservation when signing fails. */
  releaseClaim(res: ClaimReservation): void {
    this._state.claimGasSpentEth = Math.max(0, this._state.claimGasSpentEth - res.estGasEth)
    this.save()
  }

  /** Atomic write: write to .tmp then rename to final path. */
  private save(): void {
    const finalPath = join(this.dataDir, LEDGER_FILE)
    const tmpPath = finalPath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(this._state, null, 2))
    renameSync(tmpPath, finalPath)
  }
}
