// Per-day judge-call budget for eval work. Same discipline as the wallet's
// BudgetLedger: reserve BEFORE the spend (the worker asks before leasing),
// persist so a restart cannot reset the day's count, and refuse-closed on a
// corrupt file (rewrite fresh — eval budget is a cost bound, not fund custody,
// so unlike the wallet ledger it may self-heal rather than refuse to run).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

interface DayState {
  day: string // UTC YYYY-MM-DD
  used: number
}

const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10)

export class EvalBudget {
  private state: DayState

  constructor(
    private readonly file: string,
    private readonly maxPerDay: () => number,
    private readonly now: () => number = Date.now,
  ) {
    this.state = this.load()
  }

  private load(): DayState {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<DayState>
      if (typeof raw.day === 'string' && typeof raw.used === 'number' && raw.used >= 0) {
        return { day: raw.day, used: raw.used }
      }
      // Parsed but wrong shape: same reset, same visibility requirement.
      console.error(`orquestra: evalwork: budget file ${this.file} had unexpected shape — resetting day counter (cap may be spent twice today)`)
    } catch (e) {
      // Missing file is the normal first run; anything else (corrupt JSON,
      // EACCES…) still self-heals — cost bound, not fund custody — but NEVER
      // silently: a disk flipping this file daily would otherwise double the
      // operator's spend every day with zero trace.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`orquestra: evalwork: budget file ${this.file} unreadable (${(e as Error).message}) — resetting day counter (cap may be spent twice today)`)
      }
    }
    return { day: utcDay(this.now()), used: 0 }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.state))
  }

  private roll(): void {
    const today = utcDay(this.now())
    if (this.state.day !== today) this.state = { day: today, used: 0 }
  }

  /** True if a judge call may start now. Does not reserve. */
  hasBudget(): boolean {
    this.roll()
    return this.state.used < this.maxPerDay()
  }

  /** Reserve one judge call BEFORE making it. Returns false (and spends
   *  nothing) once the day's cap is reached. */
  reserve(): boolean {
    this.roll()
    if (this.state.used >= this.maxPerDay()) return false
    this.state.used += 1
    this.persist()
    return true
  }

  usedToday(): number {
    this.roll()
    return this.state.used
  }
}
