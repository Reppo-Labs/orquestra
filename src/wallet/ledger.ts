// src/wallet/ledger.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface BudgetCaps {
  voteGasEthMax: number
  voteRateMaxPerCycle: number
  mintReppoMax: number
  mintGasEthMax: number
}

export interface LedgerState {
  cycleId: string
  votesCastThisCycle: number
  voteGasSpentEth: number // cumulative over horizon
  mintReppoSpent: number // cumulative
  mintGasSpentEth: number // cumulative
}

const LEDGER_FILE = 'budget-ledger.json'
const fresh = (): LedgerState => ({
  cycleId: '', votesCastThisCycle: 0, voteGasSpentEth: 0, mintReppoSpent: 0, mintGasSpentEth: 0,
})

/** Persisted per-pool budget enforcement. The ONLY authority on whether an
 *  action is affordable. All caps are hard: at the cap, the action is refused. */
export class BudgetLedger {
  readonly state: LedgerState
  constructor(private readonly dataDir: string, private readonly caps: BudgetCaps) {
    const path = join(dataDir, LEDGER_FILE)
    this.state = existsSync(path) ? { ...fresh(), ...JSON.parse(readFileSync(path, 'utf-8')) } : fresh()
  }

  /** Reset per-cycle counters when entering a new cycle. Cumulative totals persist. */
  startCycle(cycleId: string): void {
    if (cycleId !== this.state.cycleId) {
      this.state.cycleId = cycleId
      this.state.votesCastThisCycle = 0
      this.save()
    }
  }

  canVote(): boolean {
    return this.state.votesCastThisCycle < this.caps.voteRateMaxPerCycle
      && this.state.voteGasSpentEth < this.caps.voteGasEthMax
  }

  canMint(estReppoCost: number): boolean {
    return this.state.mintReppoSpent + estReppoCost <= this.caps.mintReppoMax
      && this.state.mintGasSpentEth < this.caps.mintGasEthMax
  }

  recordVote(gasEth: number): void {
    this.state.votesCastThisCycle += 1
    this.state.voteGasSpentEth += gasEth
    this.save()
  }

  recordMint(reppo: number, gasEth: number): void {
    this.state.mintReppoSpent += reppo
    this.state.mintGasSpentEth += gasEth
    this.save()
  }

  private save(): void {
    writeFileSync(join(this.dataDir, LEDGER_FILE), JSON.stringify(this.state, null, 2))
  }
}
