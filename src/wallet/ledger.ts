// src/wallet/ledger.ts
import { readFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { getDb, type SqliteDb } from '../dashboard/db.js'

export interface BudgetCaps {
  voteGasEthMax: number
  voteRateMaxPerCycle: number
  mintReppoMax: number
  mintGasEthMax: number
  claimGasEthMax: number
  /** Cumulative REPPO allowed for one-time subnet-access grants. 0 = grants disabled. */
  /** Cumulative cap on subnet-access grant fees. undefined = no cap: joining a
   *  datanet (vote/mint enabled in config) is the consent to pay its grant fee.
   *  Set a number to bound total grant spend (0 disables grants entirely). */
  grantReppoMax?: number
}

export interface LedgerState {
  cycleId: string
  votesCastThisCycle: number
  voteGasSpentEth: number // cumulative within the current horizon window
  mintReppoSpent: number // cumulative within the current horizon window
  mintGasSpentEth: number // cumulative within the current horizon window
  claimGasSpentEth: number // cumulative within the current horizon window
  grantReppoSpent: number // cumulative REPPO spent on subnet-access grants (current window)
  /** ISO start of the current budget horizon window; cumulative spend resets when
   *  horizonDays elapse past this. '' until the first cycle initializes it. */
  horizonStart: string
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

export interface GrantReservation {
  kind: 'grant'
  estReppo: number
}

/** Thrown when the persisted ledger file exists but is corrupt or invalid.
 *  Fail-closed: the process must not continue with an unknown spend state. */
export class LedgerCorruptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerCorruptError'
  }
}

const LEGACY_LEDGER = 'budget-ledger.json'

const nonNegativeFinite = z.number().finite().nonnegative()

const LedgerSchema = z.object({
  cycleId: z.string(),
  votesCastThisCycle: nonNegativeFinite,
  voteGasSpentEth: nonNegativeFinite,
  mintReppoSpent: nonNegativeFinite,
  mintGasSpentEth: nonNegativeFinite,
  claimGasSpentEth: nonNegativeFinite.default(0),
  grantReppoSpent: nonNegativeFinite.default(0),
  horizonStart: z.string().default(''),
})

const fresh = (): LedgerState => ({
  cycleId: '', votesCastThisCycle: 0, voteGasSpentEth: 0, mintReppoSpent: 0, mintGasSpentEth: 0, claimGasSpentEth: 0, grantReppoSpent: 0, horizonStart: '',
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
  private readonly db: SqliteDb

  constructor(private readonly dataDir: string, private caps: BudgetCaps, private horizonDays = 0) {
    this.db = getDb(dataDir)
    this.importLegacy()
    const row = this.db.prepare('SELECT data FROM budget_ledger WHERE id = 1').get() as { data: string } | undefined
    if (row) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.data)
      } catch (e) {
        throw new LedgerCorruptError(`budget_ledger row is not valid JSON: ${(e as Error).message}`)
      }
      const result = LedgerSchema.safeParse(parsed)
      if (!result.success) {
        throw new LedgerCorruptError(`budget_ledger row failed validation: ${result.error.message}`)
      }
      this._state = result.data
    } else {
      this._state = fresh()
    }
  }

  /** One-time import of a pre-existing budget-ledger.json into the empty table, then
   *  rename it *.imported. A corrupt legacy file throws (fail-closed: never continue
   *  with an unknown spend state). No-op once the row exists. */
  private importLegacy(): void {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM budget_ledger').get() as { n: number }).n
    if (n > 0) return
    const path = join(this.dataDir, LEGACY_LEDGER)
    if (!existsSync(path)) return
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
    this.db.prepare('INSERT INTO budget_ledger (id, data) VALUES (1, ?)').run(JSON.stringify(result.data))
    renameSync(path, path + '.imported')
  }

  /** Returns a frozen copy of the current ledger state. */
  get state(): Readonly<LedgerState> {
    return Object.freeze({ ...this._state })
  }

  /** Reset per-cycle counters when entering a new cycle. Cumulative totals persist
   *  until the horizon window rolls over (see rollHorizonIfElapsed). */
  startCycle(cycleId: string): void {
    this.rollHorizonIfElapsed(cycleId)
    if (cycleId !== this._state.cycleId) {
      this._state.cycleId = cycleId
      this._state.votesCastThisCycle = 0
      this.save()
    }
  }

  /** Roll the budget window: when horizonDays elapse past horizonStart, the cumulative
   *  spend counters reset to 0 — so the caps are "spend per horizon window", not lifetime.
   *  `cycleId` is the cycle's ISO timestamp (the clock source); non-timestamp cycleIds
   *  (tests) and horizonDays<=0 disable rollover. First valid cycle just seeds the start. */
  private rollHorizonIfElapsed(cycleId: string): void {
    if (this.horizonDays <= 0) return
    const now = Date.parse(cycleId)
    if (Number.isNaN(now)) return
    const start = Date.parse(this._state.horizonStart)
    if (Number.isNaN(start)) { this._state.horizonStart = cycleId; this.save(); return }
    if (now - start < this.horizonDays * 86_400_000) return
    this._state.voteGasSpentEth = 0
    this._state.mintReppoSpent = 0
    this._state.mintGasSpentEth = 0
    this._state.claimGasSpentEth = 0
    this._state.grantReppoSpent = 0
    this._state.horizonStart = cycleId
    this.save()
  }

  /** Hot-reload the horizon window length (config change). Caps move via updateCaps. */
  updateHorizonDays(days: number): void { this.horizonDays = days }

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
  /** Adjust gas AND (when the CLI reports it, >=0.8.4) the REPPO fee to actuals.
   *  Reconciling REPPO makes mintReppoMax a real, retrospective cap: once actual
   *  spend exceeds it, the next reserveMint refuses (at most one mint overshoot). */
  reconcileMint(res: MintReservation, actualGasEth: number, actualReppo?: number): void {
    this._state.mintGasSpentEth += (actualGasEth - res.estGasEth)
    this._state.mintGasSpentEth = Math.max(0, this._state.mintGasSpentEth)
    if (actualReppo !== undefined) {
      this._state.mintReppoSpent += (actualReppo - res.estReppo)
      this._state.mintReppoSpent = Math.max(0, this._state.mintReppoSpent)
    }
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

  /** Swap budget caps at a cycle boundary (config hot-reload). Spent counters are
   *  untouched — only the ceilings move. */
  updateCaps(caps: BudgetCaps): void { this.caps = caps }

  canGrant(estReppo: number): boolean {
    if (this.caps.grantReppoMax === undefined) return true // no cap: datanet membership is the consent
    return this._state.grantReppoSpent + estReppo <= this.caps.grantReppoMax
  }

  /** Debit and persist BEFORE signing. Returns null if over the explicit grant REPPO
   *  cap (no debit). Unset cap always allows; spend is still tracked in the ledger. */
  reserveGrant(estReppo: number): GrantReservation | null {
    if (!this.canGrant(estReppo)) return null
    this._state.grantReppoSpent += estReppo
    this.save()
    return { kind: 'grant', estReppo }
  }

  /** Adjust the grant fee to the CLI-reported actual (est is conservative). */
  reconcileGrant(res: GrantReservation, actualReppo: number): void {
    this._state.grantReppoSpent += (actualReppo - res.estReppo)
    this._state.grantReppoSpent = Math.max(0, this._state.grantReppoSpent)
    this.save()
  }

  /** Roll back the reservation when signing fails (or access was already granted). */
  releaseGrant(res: GrantReservation): void {
    this._state.grantReppoSpent = Math.max(0, this._state.grantReppoSpent - res.estReppo)
    this.save()
  }

  /** Persist the single ledger row. One UPSERT statement is atomic in SQLite —
   *  same crash-safety as the old tmp+rename, with no torn writes. */
  private save(): void {
    this.db
      .prepare('INSERT INTO budget_ledger (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(JSON.stringify(this._state))
  }
}
