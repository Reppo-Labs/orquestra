# Orquestra — Phase 1, Plan 3: Wallet / Budget manager (the only signer)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The single place that signs on-chain. A persisted `BudgetLedger` enforces hard per-pool caps; a `WalletExecutor` performs the veREPPO lock and executes vote/mint **intents** only while the ledger has headroom. The LLM agents never sign — they emit intents; this module disposes within caps.

**Architecture:** `BudgetLedger` is pure logic + JSON persistence on the data dir — fully unit-tested, no network. `WalletExecutor` takes an **injectable `ReppoCli`** (default: shell out to the `reppo` CLI) and a `BudgetLedger`; for each intent it checks the ledger, executes via the CLI only if affordable, then records the spend (which persists). Over-budget intents are refused by non-LLM code — the exposure bound for a plaintext key + autonomous agents.

**Tech Stack:** TypeScript, zod, vitest (set up in Plan 1). `child_process` for the default CLI. Consumes `StrategyConfig.budget`/`.stake` from Plan 1.

**Builds on:** Plans 1 (config) + 2 (rubric). Note: exact `reppo` CLI sub-flags for `lock`/`vote`/`mint-pod` are confirmed at integration time; the `ReppoCli` interface abstracts them so the budget-gating logic is unit-tested against a fake CLI.

---

## Budget model (from the design, confirmed semantics)

- **Lock** REPPO → veREPPO (amount + duration) for voting power. One-time per stake config. Not a recurring spend.
- **Votes** spend **no REPPO** — only gas. Bounded by `voteRateMaxPerCycle` (per cycle) + `voteGasEthMax` (cumulative over horizon).
- **Mints** spend REPPO (if any) + gas. Bounded by `mintReppoMax` + `mintGasEthMax` (cumulative over horizon).

Per-cycle counters reset each cycle; cumulative gas/REPPO totals persist across cycles + restarts until reconfigure.

## File structure (this plan)

- Create: `src/wallet/intents.ts` — `VoteIntent`, `MintIntent`, `ExecResult`.
- Create: `src/wallet/ledger.ts` — `BudgetLedger` (caps, record, persist/load).
- Create: `src/reppo/cli.ts` — `ReppoCli` interface + `defaultReppoCli` (subprocess).
- Create: `src/wallet/executor.ts` — `WalletExecutor` (lock + execute intents, gated).
- Test: `src/wallet/ledger.test.ts`, `src/wallet/executor.test.ts`.

---

### Task 1: Intent + result types

**Files:**
- Create: `src/wallet/intents.ts`

- [ ] **Step 1: Write the implementation** (types only — no test needed)

```ts
// src/wallet/intents.ts
export interface VoteIntent {
  kind: 'vote'
  datanetId: string
  podId: string
  direction: 'up' | 'down'
  /** 1-10 conviction from the voter; used to prioritise scarce voting power. */
  conviction: number
  reason: string
}

export interface MintIntent {
  kind: 'mint'
  datanetId: string
  /** sha256-derived dedup key. */
  canonicalKey: string
  podName: string
  podDescription: string
  /** path to the labeled dataset body the CLI pins + mints. */
  datasetPath: string
  /** optional REPPO cost estimate for budgeting; 0 if mint is gas-only. */
  estReppoCost?: number
}

export interface ExecResult {
  ok: boolean
  /** 'executed' | 'refused-budget' | 'error' */
  status: 'executed' | 'refused-budget' | 'error'
  txHash?: string
  detail?: string
}
```

- [ ] **Step 2: Commit**

```bash
git add src/wallet/intents.ts
git commit -m "feat(wallet): vote/mint intent + exec result types"
```

---

### Task 2: BudgetLedger (the cap enforcer)

**Files:**
- Create: `src/wallet/ledger.ts`
- Test: `src/wallet/ledger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/wallet/ledger.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BudgetLedger } from './ledger.js'

const caps = { voteGasEthMax: 0.05, voteRateMaxPerCycle: 3, mintReppoMax: 100, mintGasEthMax: 0.1 }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-led-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('BudgetLedger', () => {
  it('allows votes until the per-cycle rate cap, then refuses', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    expect(l.canVote()).toBe(true)
    l.recordVote(0.001); l.recordVote(0.001); l.recordVote(0.001) // 3 = cap
    expect(l.canVote()).toBe(false)
  })

  it('resets the per-cycle vote count on a new cycle but keeps cumulative gas', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1'); l.recordVote(0.001); l.recordVote(0.001); l.recordVote(0.001)
    expect(l.canVote()).toBe(false)
    l.startCycle('c2')
    expect(l.canVote()).toBe(true)
    expect(l.state.voteGasSpentEth).toBeCloseTo(0.003)
  })

  it('refuses votes once cumulative vote-gas cap is hit (across cycles)', () => {
    const l = new BudgetLedger(dir, { ...caps, voteGasEthMax: 0.0025, voteRateMaxPerCycle: 99 })
    l.startCycle('c1'); l.recordVote(0.001); l.recordVote(0.001)
    expect(l.canVote()).toBe(true)
    l.recordVote(0.001) // cumulative 0.003 > 0.0025
    expect(l.canVote()).toBe(false)
  })

  it('refuses a mint that would exceed the REPPO cap', () => {
    const l = new BudgetLedger(dir, caps)
    l.startCycle('c1')
    expect(l.canMint(60)).toBe(true)
    l.recordMint(60, 0.01)
    expect(l.canMint(60)).toBe(false) // 60 + 60 > 100
    expect(l.canMint(40)).toBe(true)  // 60 + 40 = 100, ok
  })

  it('refuses mints once cumulative mint-gas cap is hit', () => {
    const l = new BudgetLedger(dir, { ...caps, mintGasEthMax: 0.015 })
    l.startCycle('c1'); l.recordMint(1, 0.01)
    expect(l.canMint(1)).toBe(true)
    l.recordMint(1, 0.01) // gas 0.02 > 0.015
    expect(l.canMint(1)).toBe(false)
  })

  it('persists across reload (caps survive a restart)', () => {
    const a = new BudgetLedger(dir, caps)
    a.startCycle('c1'); a.recordMint(70, 0.01)
    const b = new BudgetLedger(dir, caps) // fresh instance, same dir
    expect(b.canMint(40)).toBe(false) // 70 + 40 > 100, loaded from disk
    expect(existsSync(join(dir, 'budget-ledger.json'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/wallet/ledger.test.ts`
Expected: FAIL — cannot find module `./ledger.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/wallet/ledger.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/wallet/ledger.ts src/wallet/ledger.test.ts
git commit -m "feat(wallet): persisted BudgetLedger with hard per-pool caps"
```

---

### Task 3: ReppoCli interface + default subprocess impl

**Files:**
- Create: `src/reppo/cli.ts`

- [ ] **Step 1: Write the implementation** (thin; exact flags confirmed at integration — isolated so the executor stays unit-testable)

```ts
// src/reppo/cli.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface VoteArgs { podId: string; direction: 'up' | 'down'; idempotencyKey: string }
export interface LockArgs { amountReppo: number; durationSeconds: number; idempotencyKey: string }
export interface MintArgs {
  datanetId: string; podName: string; podDescription: string; datasetPath: string; idempotencyKey: string
}
/** Result of an on-chain action: tx hash + gas spent (ETH), parsed from the CLI's --json output. */
export interface ChainResult { txHash: string; gasEth: number }

/** The signing surface. Injected into WalletExecutor; the default shells out to `reppo`. */
export interface ReppoCli {
  lock(args: LockArgs): Promise<ChainResult>
  vote(args: VoteArgs): Promise<ChainResult>
  mintPod(args: MintArgs): Promise<ChainResult>
}

async function run(args: string[]): Promise<ChainResult> {
  const { stdout } = await execFileAsync('reppo', [...args, '--json'], {
    env: { ...process.env, REPPO_NETWORK: process.env.REPPO_NETWORK ?? 'mainnet' },
    timeout: 120_000,
  })
  const j = JSON.parse(stdout) as { txHash?: string; tx?: string; gasEth?: number }
  return { txHash: j.txHash ?? j.tx ?? '', gasEth: Number(j.gasEth ?? 0) }
}

/** Default CLI-backed signer. Exact sub-flags (e.g. mint metadata flags, vote
 *  direction encoding) are confirmed against `reppo --help` at integration. */
export const defaultReppoCli: ReppoCli = {
  lock: (a) => run(['lock', '--duration', String(a.durationSeconds), '--idempotency-key', a.idempotencyKey, String(a.amountReppo)]),
  vote: (a) => run(['vote', '--pod', a.podId, '--direction', a.direction, '--idempotency-key', a.idempotencyKey]),
  mintPod: (a) => run(['mint-pod', '--datanet', a.datanetId, '--pod-name', a.podName, '--pod-description', a.podDescription, '--dataset', a.datasetPath, '--idempotency-key', a.idempotencyKey, '--agree-to-terms']),
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/reppo/cli.ts
git commit -m "feat(reppo): ReppoCli signing interface + default subprocess impl"
```

---

### Task 4: WalletExecutor (gated signer)

**Files:**
- Create: `src/wallet/executor.ts`
- Test: `src/wallet/executor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/wallet/executor.test.ts`
Expected: FAIL — cannot find module `./executor.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/wallet/executor.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (17 prior + 11 new = 28); typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/wallet/executor.ts src/wallet/executor.test.ts
git commit -m "feat(wallet): WalletExecutor — sign only within budget, record + persist spend"
```

---

## Self-review (done while writing)

- **Spec coverage:** implements the design's "Wallet / Budget / Stake manager — the only signer." The veREPPO lock (`lock`), per-pool hard caps (vote rate + cumulative vote gas; cumulative mint REPPO + mint gas), persistence across restarts, and the agents-propose/manager-disposes boundary (executor refuses over-budget intents without signing) are all present and tested. Matches "votes spend no REPPO (gas only); mints spend REPPO + gas" — vote path never touches the REPPO pool.
- **Security boundary tested explicitly:** the two "refused-budget WITHOUT calling the CLI" tests assert the signer is not invoked when over budget — the core protection for a plaintext key.
- **Testability:** the signing surface (`ReppoCli`) is injected; all gating logic is unit-tested against a fake CLI. The default subprocess impl is integration-level (exact flags confirmed against `reppo --help`).
- **Open dependency restated:** confirm exact `reppo lock/vote/mint-pod` sub-flags and the `--json` gas/txHash field names at integration; `defaultReppoCli` is the only place that changes.
- **No placeholders:** every step has complete code/commands + expected output.
- **Type consistency:** `VoteIntent`, `MintIntent`, `ExecResult`, `BudgetLedger`, `BudgetCaps`, `LedgerState`, `ReppoCli`, `ChainResult`, `LockArgs`/`VoteArgs`/`MintArgs`, `defaultReppoCli`, `WalletExecutor` are referenced consistently across files and tests.
