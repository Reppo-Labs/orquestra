# Orquestra Dashboard + Emissions Claiming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The swarm claims earned REPPO emissions each cycle, persists a per-action activity log + on-chain snapshot, and serves a read-only `localhost` dashboard showing votes/mints/claims, spend, claimable + claimed emissions, and PnL.

**Architecture:** Phase A adds a claim phase to the existing per-cycle flow (`runCycle`), routed through the single signer `WalletExecutor` with a gas cap, plus an append-only `activity-log.jsonl`. Phase B adds a snapshot writer and a dependency-free Node `http` server (no framework, no build step) that reads those files. The HTTP server is strictly read-only and never imports the executor or private key.

**Tech Stack:** TypeScript (NodeNext, strict), Node built-in `http`/`fs`, vitest, zod. No new runtime dependencies.

**Reference spec:** `docs/superpowers/specs/2026-06-03-orquestra-dashboard-design.md`

**Conventions in this codebase (read before starting):**
- ESM with `.js` import suffixes (NodeNext). Tests are `*.test.ts` colocated with source.
- Pure logic is unit-tested; CLI-shelling wrappers are typecheck/build-only and exercised via injected fakes (DI).
- Atomic file writes = write `<path>.tmp` then `renameSync` to `<path>`.
- reppo CLI wrappers go through `reppoEnv()` + `withRpcUrl()` from `src/reppo/exec.ts`.
- Run the suite with `npm test -- --run`; typecheck with `npm run typecheck`; build with `npm run build`.

---

# Phase A — Emissions claiming

### Task 1: `ClaimIntent` + `ExecResult.gasEth`

**Files:**
- Modify: `src/wallet/intents.ts`

- [ ] **Step 1: Add the ClaimIntent interface and gasEth field**

Append `ClaimIntent` and add `gasEth?` to `ExecResult` in `src/wallet/intents.ts`:

```ts
export interface ClaimIntent {
  kind: 'claim'
  datanetId: string
  podId: string
  epoch: number
  /** unclaimed REPPO this (pod, epoch) is worth at claim time; recorded for PnL. */
  reppoDue: number
  idempotencyKey: string
}

export interface ExecResult {
  ok: boolean
  /** 'executed' | 'refused-budget' | 'error' */
  status: 'executed' | 'refused-budget' | 'error'
  txHash?: string
  /** actual gas (ETH) when known; surfaced for the activity log. */
  gasEth?: number
  detail?: string
}
```

(Replace the existing `ExecResult` interface; keep `VoteIntent`/`MintIntent` untouched.)

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS (no usages break — `gasEth` is optional).

- [ ] **Step 3: Commit**

```bash
git add src/wallet/intents.ts
git commit -m "feat(wallet): add ClaimIntent + optional ExecResult.gasEth"
```

---

### Task 2: Activity log (type + append/read)

**Files:**
- Create: `src/dashboard/activityLog.ts`
- Test: `src/dashboard/activityLog.test.ts`

This file owns the `ActivityEntry` type used by both the cycle (Phase A) and the dashboard (Phase B), so it is built first.

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/activityLog.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendActivity, readActivity, type ActivityEntry } from './activityLog.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-act-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  ts: '2026-06-03T21:38:38.651Z', cycleId: 'c1', kind: 'vote', datanetId: '9',
  podId: '1', direction: 'up', conviction: 9, reason: 'r', status: 'executed', txHash: '0xabc', ...over,
})

describe('activityLog', () => {
  it('append then read returns entries newest-first', () => {
    appendActivity(dir, entry({ podId: '1' }))
    appendActivity(dir, entry({ podId: '2' }))
    const rows = readActivity(dir, { limit: 10 })
    expect(rows.map((r) => r.podId)).toEqual(['2', '1']) // newest first
  })

  it('returns [] when the log does not exist', () => {
    expect(readActivity(dir, { limit: 10 })).toEqual([])
  })

  it('honours the limit (most recent N)', () => {
    for (let i = 0; i < 5; i++) appendActivity(dir, entry({ podId: String(i) }))
    const rows = readActivity(dir, { limit: 2 })
    expect(rows.map((r) => r.podId)).toEqual(['4', '3'])
  })

  it('tolerates a torn final line (partial write)', () => {
    appendActivity(dir, entry({ podId: '1' }))
    appendFileSync(join(dir, 'activity-log.jsonl'), '{"ts":"x","kind":"vote"') // no newline, invalid
    const rows = readActivity(dir, { limit: 10 })
    expect(rows.map((r) => r.podId)).toEqual(['1']) // bad line skipped
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --run src/dashboard/activityLog.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/dashboard/activityLog.ts`**

```ts
// src/dashboard/activityLog.ts
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ActivityEntry {
  ts: string
  cycleId: string
  kind: 'vote' | 'mint' | 'claim'
  datanetId: string
  podId?: string
  direction?: 'up' | 'down'
  conviction?: number
  reason?: string
  canonicalKey?: string
  podName?: string
  epoch?: number
  reppoClaimed?: number
  status: 'executed' | 'refused-budget' | 'error'
  txHash?: string
  gasEth?: number
  detail?: string
}

const FILE = 'activity-log.jsonl'

/** Append one entry as a single JSON line. Crash-safe: one line per action. */
export function appendActivity(dataDir: string, entry: ActivityEntry): void {
  appendFileSync(join(dataDir, FILE), JSON.stringify(entry) + '\n')
}

/** Read the most recent `limit` entries, newest-first. Skips unparseable lines
 *  (e.g. a torn final line from a crash). Missing file → []. */
export function readActivity(dataDir: string, opts: { limit: number }): ActivityEntry[] {
  const path = join(dataDir, FILE)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim() !== '')
  const out: ActivityEntry[] = []
  for (const line of lines) {
    try { out.push(JSON.parse(line) as ActivityEntry) } catch { /* skip torn/invalid line */ }
  }
  return out.reverse().slice(0, opts.limit)
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- --run src/dashboard/activityLog.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/activityLog.ts src/dashboard/activityLog.test.ts
git commit -m "feat(dashboard): append-only activity log (ActivityEntry + append/read)"
```

---

### Task 3: BudgetLedger claim caps

**Files:**
- Modify: `src/wallet/ledger.ts`
- Test: `src/wallet/ledger.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/wallet/ledger.test.ts` a new describe. Use the existing test setup pattern in the file; the new block:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BudgetLedger, type BudgetCaps } from './ledger.js'

const CAPS: BudgetCaps = {
  voteGasEthMax: 0.05, voteRateMaxPerCycle: 30, mintReppoMax: 500, mintGasEthMax: 0.05, claimGasEthMax: 0.01,
}

describe('BudgetLedger claim gas cap', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-led-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reserves, reconciles to actual, and persists claimGasSpentEth', () => {
    const l = new BudgetLedger(dir, CAPS)
    const res = l.reserveClaim(0.003)!
    expect(res).not.toBeNull()
    l.reconcileClaim(res, 0.004) // actual higher than est
    expect(l.state.claimGasSpentEth).toBeCloseTo(0.004)
  })

  it('refuses once claimGasEthMax is reached', () => {
    const l = new BudgetLedger(dir, CAPS)
    const a = l.reserveClaim(0.006); expect(a).not.toBeNull()
    const b = l.reserveClaim(0.006) // 0.012 > 0.01 cap
    expect(b).toBeNull()
  })

  it('release rolls back a reservation', () => {
    const l = new BudgetLedger(dir, CAPS)
    const res = l.reserveClaim(0.004)!
    l.releaseClaim(res)
    expect(l.state.claimGasSpentEth).toBeCloseTo(0)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --run src/wallet/ledger.test.ts`
Expected: FAIL (`claimGasEthMax`/`reserveClaim` do not exist).

- [ ] **Step 3: Implement the claim caps in `src/wallet/ledger.ts`**

Add `claimGasEthMax` to `BudgetCaps`:

```ts
export interface BudgetCaps {
  voteGasEthMax: number
  voteRateMaxPerCycle: number
  mintReppoMax: number
  mintGasEthMax: number
  claimGasEthMax: number
}
```

Add `claimGasSpentEth` to `LedgerState`, its zod field, and `fresh()`:

```ts
export interface LedgerState {
  cycleId: string
  votesCastThisCycle: number
  voteGasSpentEth: number
  mintReppoSpent: number
  mintGasSpentEth: number
  claimGasSpentEth: number
}
```

```ts
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
```

> Note: `.default(0)` on the schema field lets a pre-existing `budget-ledger.json` (written before this field existed) load without tripping `LedgerCorruptError`. The current `LedgerSchema` does NOT use `.strict()`, so the default applies on parse — keep it that way.

Add a `ClaimReservation` type and the four methods (mirror the vote-gas pattern; claim has no per-cycle rate, only a gas cap):

```ts
export interface ClaimReservation {
  kind: 'claim'
  estGasEth: number
}
```

```ts
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
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- --run src/wallet/ledger.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/wallet/ledger.ts src/wallet/ledger.test.ts
git commit -m "feat(wallet): claim gas cap (claimGasEthMax) on BudgetLedger"
```

---

### Task 4: `ReppoCli.claimEmissions`

**Files:**
- Modify: `src/reppo/cli.ts`

- [ ] **Step 1: Add `claimEmissions` to the interface and default impl**

In `src/reppo/cli.ts` add a `ClaimEmissionsArgs` type, extend `ReppoCli`, and add the default implementation (using the existing `run()` helper, which already appends `--json` and routes through `withRpcUrl`/`reppoEnv`):

```ts
export interface ClaimEmissionsArgs { podId: string; epoch: number; idempotencyKey: string }
```

```ts
export interface ReppoCli {
  lock(args: LockArgs): Promise<ChainResult>
  vote(args: VoteArgs): Promise<ChainResult>
  mintPod(args: MintArgs): Promise<ChainResult>
  claimEmissions(args: ClaimEmissionsArgs): Promise<ChainResult>
}
```

```ts
export const defaultReppoCli: ReppoCli = {
  lock: (a) => run(['lock', '--duration', String(a.durationSeconds), '--idempotency-key', a.idempotencyKey, String(a.amountReppo)]),
  vote: (a) => run(['vote', '--pod', a.podId, '--direction', a.direction, '--idempotency-key', a.idempotencyKey]),
  mintPod: (a) => run(['mint-pod', '--datanet', a.datanetId, '--pod-name', a.podName, '--pod-description', a.podDescription, '--dataset', a.datasetPath, '--idempotency-key', a.idempotencyKey, '--agree-to-terms']),
  claimEmissions: (a) => run(['claim-emissions', '--pod', a.podId, '--epoch', String(a.epoch), '--idempotency-key', a.idempotencyKey]),
}
```

> Note: exact sub-flag spelling is confirmed against `reppo claim-emissions --help` (0.7.0) at integration, same convention as the other commands.

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: It may FAIL in `src/wallet/executor.test.ts` if that file's fake `ReppoCli` lacks `claimEmissions` — that fake is updated in Task 5, where this resolves. Otherwise PASS.

- [ ] **Step 3: Commit**

```bash
git add src/reppo/cli.ts
git commit -m "feat(reppo): ReppoCli.claimEmissions wrapper"
```

---

### Task 5: `WalletExecutor.executeClaim` + surface `gasEth`

**Files:**
- Modify: `src/wallet/executor.ts`
- Test: `src/wallet/executor.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/wallet/executor.test.ts`. Update the suite's fake `ReppoCli` to include `claimEmissions`, then add claim tests. The new block (adapt to the file's existing setup):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WalletExecutor } from './executor.js'
import { BudgetLedger, type BudgetCaps } from './ledger.js'
import type { ReppoCli } from '../reppo/cli.js'
import type { ClaimIntent } from './intents.js'

const CAPS: BudgetCaps = { voteGasEthMax: 0.05, voteRateMaxPerCycle: 30, mintReppoMax: 500, mintGasEthMax: 0.05, claimGasEthMax: 0.05 }
const claim = (over: Partial<ClaimIntent> = {}): ClaimIntent => ({ kind: 'claim', datanetId: '9', podId: '1', epoch: 101, reppoDue: 12.5, idempotencyKey: 'claim-1-101', ...over })

const fakeCli = (over: Partial<ReppoCli> = {}): ReppoCli => ({
  lock: async () => ({ txHash: '0xlock', gasEth: 0 }),
  vote: async () => ({ txHash: '0xvote', gasEth: 0.001 }),
  mintPod: async () => ({ txHash: '0xmint', gasEth: 0.01 }),
  claimEmissions: async () => ({ txHash: '0xclaim', gasEth: 0.0009 }),
  ...over,
})

describe('WalletExecutor.executeClaim', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-exec-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('claims, reconciles gas, returns txHash + gasEth', async () => {
    const ledger = new BudgetLedger(dir, CAPS)
    const ex = new WalletExecutor(fakeCli(), ledger)
    const r = await ex.executeClaim(claim())
    expect(r.status).toBe('executed')
    expect(r.txHash).toBe('0xclaim')
    expect(r.gasEth).toBeCloseTo(0.0009)
    expect(ledger.state.claimGasSpentEth).toBeCloseTo(0.0009)
  })

  it('refuses when the claim gas cap is exhausted', async () => {
    const ledger = new BudgetLedger(dir, { ...CAPS, claimGasEthMax: 0 })
    const ex = new WalletExecutor(fakeCli(), ledger)
    const r = await ex.executeClaim(claim())
    expect(r.status).toBe('refused-budget')
  })

  it('releases the reservation when the CLI throws', async () => {
    const ledger = new BudgetLedger(dir, CAPS)
    const ex = new WalletExecutor(fakeCli({ claimEmissions: async () => { throw new Error('rpc down') } }), ledger)
    const r = await ex.executeClaim(claim())
    expect(r.status).toBe('error')
    expect(ledger.state.claimGasSpentEth).toBeCloseTo(0)
  })

  it('surfaces gasEth on vote results too', async () => {
    const ledger = new BudgetLedger(dir, CAPS)
    const ex = new WalletExecutor(fakeCli(), ledger)
    const r = await ex.executeVote({ kind: 'vote', datanetId: '9', podId: '1', direction: 'up', conviction: 9, reason: 'r' })
    expect(r.gasEth).toBeCloseTo(0.001)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --run src/wallet/executor.test.ts`
Expected: FAIL (`executeClaim` missing; vote result has no `gasEth`).

- [ ] **Step 3: Implement in `src/wallet/executor.ts`**

Add the gas estimate constant, import `ClaimIntent`, surface `gasEth` on vote/mint success, and add `executeClaim`:

```ts
import type { VoteIntent, MintIntent, ClaimIntent, ExecResult } from './intents.js'

const VOTE_GAS_EST_ETH = 0.003
const MINT_GAS_EST_ETH = 0.02
const CLAIM_GAS_EST_ETH = 0.003
```

In `executeVote`, change the success return to include gas:

```ts
      this.ledger.reconcileVote(res, r.gasEth)
      return { ok: true, status: 'executed', txHash: r.txHash, gasEth: r.gasEth }
```

In `executeMint`, likewise:

```ts
      this.ledger.reconcileMint(res, r.gasEth)
      return { ok: true, status: 'executed', txHash: r.txHash, gasEth: r.gasEth }
```

Add the method:

```ts
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
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- --run src/wallet/executor.test.ts`
Expected: PASS (existing + 4 new). Then `npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wallet/executor.ts src/wallet/executor.test.ts
git commit -m "feat(wallet): executeClaim + surface gasEth on all exec results"
```

---

### Task 6: `DedupState.claimedKeys`

**Files:**
- Modify: `src/runtime/state.ts`
- Test: `src/runtime/state.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/runtime/state.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DedupState } from './state.js'

describe('DedupState claimedKeys', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-st-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('records and reads claimed (pod:epoch) keys per datanet', () => {
    const s = new DedupState(dir)
    s.recordClaim('9', '1:101')
    s.recordClaim('9', '2:101')
    expect(new Set(s.getClaimedKeys('9'))).toEqual(new Set(['1:101', '2:101']))
    expect(s.getClaimedKeys('2')).toEqual([])
  })

  it('persists claimedKeys to disk', () => {
    new DedupState(dir).recordClaim('9', '1:101')
    const onDisk = JSON.parse(readFileSync(join(dir, 'vote-state.json'), 'utf-8'))
    expect(onDisk.claimedKeys['9']).toContain('1:101')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --run src/runtime/state.test.ts`
Expected: FAIL (`recordClaim`/`getClaimedKeys` missing).

- [ ] **Step 3: Implement in `src/runtime/state.ts`**

Extend `Shape`, `fresh()`, the constructor load, and add the two methods:

```ts
interface Shape {
  votedPodIds: Record<string, string[]>
  mintedKeys: Record<string, string[]>
  claimedKeys: Record<string, string[]>
}
const fresh = (): Shape => ({ votedPodIds: {}, mintedKeys: {}, claimedKeys: {} })
```

In the constructor's parse branch, add `claimedKeys`:

```ts
      this.state = {
        votedPodIds: parsed.votedPodIds ?? {},
        mintedKeys: parsed.mintedKeys ?? {},
        claimedKeys: parsed.claimedKeys ?? {},
      }
```

Add the methods next to the existing getters/recorders:

```ts
  getClaimedKeys(datanetId: string): string[] { return this.state.claimedKeys[datanetId] ?? [] }
  recordClaim(datanetId: string, key: string): void { this.add(this.state.claimedKeys, datanetId, key) }
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- --run src/runtime/state.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/state.ts src/runtime/state.test.ts
git commit -m "feat(runtime): DedupState.claimedKeys (pod:epoch idempotency)"
```

---

### Task 7: `queryEmissionsDue` wrapper + parser

**Files:**
- Create: `src/reppo/queryEmissionsDue.ts`
- Test: `src/reppo/queryEmissionsDue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/reppo/queryEmissionsDue.test.ts`. The fixture mirrors the CLI's nested `{raw,formatted}` amount convention already seen in `queryBalance`:

```ts
import { describe, it, expect } from 'vitest'
import { parseEmissionsDue } from './queryEmissionsDue.js'

describe('parseEmissionsDue', () => {
  it('maps emissions rows and sums totalReppo', () => {
    const raw = {
      emissions: [
        { podId: '1', datanetId: '9', epoch: 101, amount: { formatted: '12.5' } },
        { podId: '2', subnetId: '9', epoch: 100, amount: { formatted: '4.0' } },
      ],
    }
    const r = parseEmissionsDue(raw)
    expect(r.totalReppo).toBeCloseTo(16.5)
    expect(r.pods).toEqual([
      { podId: '1', datanetId: '9', epoch: 101, reppo: 12.5 },
      { podId: '2', datanetId: '9', epoch: 100, reppo: 4.0 },
    ])
  })

  it('returns empty for missing/garbage input', () => {
    expect(parseEmissionsDue({})).toEqual({ totalReppo: 0, pods: [] })
    expect(parseEmissionsDue(null)).toEqual({ totalReppo: 0, pods: [] })
  })

  it('drops rows with no podId', () => {
    const r = parseEmissionsDue({ emissions: [{ epoch: 1, amount: { formatted: '5' } }] })
    expect(r.pods).toEqual([])
    expect(r.totalReppo).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --run src/reppo/queryEmissionsDue.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/reppo/queryEmissionsDue.ts`**

```ts
// src/reppo/queryEmissionsDue.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { reppoEnv, withRpcUrl } from './exec.js'

const execFileAsync = promisify(execFile)

export interface ClaimableEmission { podId: string; datanetId: string; epoch: number; reppo: number }
export interface EmissionsDue { totalReppo: number; pods: ClaimableEmission[] }

const toFinite = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
/** Amount may be a nested {raw,formatted} object or a plain number/string. */
const amountReppo = (a: unknown): number => {
  if (a && typeof a === 'object' && 'formatted' in (a as Record<string, unknown>)) return toFinite((a as Record<string, unknown>).formatted)
  return toFinite(a)
}

/** Pure: extract claimable emissions from `reppo query emissions-due --json`. */
export function parseEmissionsDue(raw: unknown): EmissionsDue {
  const rows = (raw as { emissions?: unknown[] })?.emissions
  if (!Array.isArray(rows)) return { totalReppo: 0, pods: [] }
  const pods: ClaimableEmission[] = []
  for (const r of rows) {
    const d = r as Record<string, unknown>
    const podId = String(d.podId ?? d.pod ?? '')
    if (podId === '') continue
    pods.push({
      podId,
      datanetId: String(d.datanetId ?? d.subnetId ?? ''),
      epoch: toFinite(d.epoch),
      reppo: amountReppo(d.amount ?? d.reppo),
    })
  }
  return { totalReppo: pods.reduce((s, p) => s + p.reppo, 0), pods }
}

/** Live unclaimed emissions across our pods via the reppo CLI. */
export async function queryEmissionsDueJson(): Promise<EmissionsDue> {
  const { stdout } = await execFileAsync('reppo', withRpcUrl(['query', 'emissions-due', '--json']), {
    env: reppoEnv(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  })
  try { return parseEmissionsDue(JSON.parse(stdout)) } catch { throw new Error(`queryEmissionsDueJson: bad reppo output: ${stdout.slice(0, 200)}`) }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- --run src/reppo/queryEmissionsDue.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/reppo/queryEmissionsDue.ts src/reppo/queryEmissionsDue.test.ts
git commit -m "feat(reppo): queryEmissionsDue wrapper + parseEmissionsDue"
```

---

### Task 8: Config — `claimEmissions` + `claimGasEthMax`

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/onboarding/build.ts` (read it first — it constructs the `budget` object and the `StrategyConfig`)
- Test: `src/config/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/config/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { StrategyConfigSchema } from './schema.js'

const base = {
  horizonDays: 30, cadenceHours: 1,
  stake: { lockReppo: 0, lockDurationDays: 30 },
  budget: { voteGasEthMax: 0.05, voteRateMaxPerCycle: 30, mintReppoMax: 500, mintGasEthMax: 0.05, claimGasEthMax: 0.05 },
  datanets: {},
}

describe('StrategyConfig claim fields', () => {
  it('defaults claimEmissions to true', () => {
    const cfg = StrategyConfigSchema.parse(base)
    expect(cfg.claimEmissions).toBe(true)
  })
  it('requires claimGasEthMax in budget', () => {
    const { claimGasEthMax, ...partialBudget } = base.budget
    expect(() => StrategyConfigSchema.parse({ ...base, budget: partialBudget })).toThrow()
  })
  it('accepts claimEmissions:false', () => {
    expect(StrategyConfigSchema.parse({ ...base, claimEmissions: false }).claimEmissions).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --run src/config/schema.test.ts`
Expected: FAIL (`claimEmissions` undefined; `claimGasEthMax` not required).

- [ ] **Step 3: Implement in `src/config/schema.ts`**

Add `claimGasEthMax` to the `budget` object and a top-level `claimEmissions`:

```ts
    budget: z.object({
      voteGasEthMax: z.number().nonnegative(),
      voteRateMaxPerCycle: z.number().int().nonnegative(),
      mintReppoMax: z.number().nonnegative(),
      mintGasEthMax: z.number().nonnegative(),
      claimGasEthMax: z.number().nonnegative(),
    }),
    claimEmissions: z.boolean().default(true),
    datanets: z.record(z.string(), DatanetPolicy),
    notes: z.string().default(''),
```

- [ ] **Step 4: Update `src/onboarding/build.ts`**

Read `src/onboarding/build.ts`. Where it builds the `budget` object literal, add `claimGasEthMax: 0.05` (match the existing default style for `mintGasEthMax`). Where it returns the config object, add `claimEmissions: true`. (No new onboarding question — it defaults on; the operator can edit `strategy.config.json` to disable.) If `build.test.ts` asserts the exact shape of the returned object, update that assertion to include the two new fields.

- [ ] **Step 5: Run tests to confirm they pass**

Run: `npm test -- --run src/config/schema.test.ts src/onboarding/build.test.ts`
Expected: PASS. Then `npm run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts src/onboarding/build.ts src/config/schema.test.ts src/onboarding/build.test.ts
git commit -m "feat(config): claimEmissions toggle (default on) + claimGasEthMax cap"
```

---

### Task 9: Cycle claim phase + `recordActivity` + report shape

**Files:**
- Modify: `src/runtime/cycle.ts`
- Test: `src/runtime/cycle.test.ts`

This is the integration task for Phase A. Read the current `src/runtime/cycle.test.ts` first to reuse its fakes (it already provides fake `executor`, `ledger`, `getRubric`, etc.).

- [ ] **Step 1: Write the failing test**

Add a new describe to `src/runtime/cycle.test.ts`. Build on the existing test harness/fakes; the new assertions (the behavioural contract):

```ts
import { runCycle } from './cycle.js'

describe('runCycle claim phase', () => {
  it('claims each unclaimed (pod,epoch), skips already-claimed, records activity + claimedKeys', async () => {
    const recorded: string[] = []
    const activity: { kind: string; podId?: string; reppoClaimed?: number }[] = []
    const claimed = new Set<string>(['2:101']) // 2:101 already claimed
    const deps = makeDeps({ // makeDeps = the file's existing helper; override claim bits:
      getEmissionsDue: async () => [
        { podId: '1', datanetId: '9', epoch: 101, reppo: 12.5 },
        { podId: '2', datanetId: '9', epoch: 101, reppo: 4 },
      ],
      seenClaimsFor: async () => claimed,
      executor: { ...baseExecutor, executeClaim: async () => ({ ok: true, status: 'executed', txHash: '0xc', gasEth: 0.0009 }) },
      recordClaim: (_dn, key) => recorded.push(key),
      recordActivity: (e) => activity.push(e),
    })
    const report = await runCycle(configWith({ claimEmissions: true }), 'c1', deps)
    expect(report.claims).toHaveLength(1)            // only pod 1 (pod 2 already claimed)
    expect(recorded).toEqual(['1:101'])
    expect(activity.some((a) => a.kind === 'claim' && a.podId === '1' && a.reppoClaimed === 12.5)).toBe(true)
  })

  it('skips the claim phase entirely when claimEmissions is false', async () => {
    let called = 0
    const deps = makeDeps({ getEmissionsDue: async () => { called++; return [] } })
    const report = await runCycle(configWith({ claimEmissions: false }), 'c1', deps)
    expect(called).toBe(0)
    expect(report.claims).toEqual([])
  })

  it('isolates a single failing claim from the rest', async () => {
    const deps = makeDeps({
      getEmissionsDue: async () => [
        { podId: '1', datanetId: '9', epoch: 101, reppo: 5 },
        { podId: '2', datanetId: '9', epoch: 101, reppo: 5 },
      ],
      seenClaimsFor: async () => new Set<string>(),
      executor: { ...baseExecutor, executeClaim: async (i) => i.podId === '1' ? Promise.reject(new Error('boom')) : { ok: true, status: 'executed', txHash: '0xc', gasEth: 0.0009 } },
    })
    const report = await runCycle(configWith({ claimEmissions: true }), 'c1', deps)
    expect(report.claims.filter((c) => c.status === 'executed')).toHaveLength(1) // pod 2 still claimed
  })
})
```

> The implementer adapts `makeDeps`/`baseExecutor`/`configWith` to the helpers already in the test file. If those names don't exist, factor small local helpers from the existing setup. The behavioural assertions above are the contract. Existing tests that read the report as an array must change to `report.datanets`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --run src/runtime/cycle.test.ts`
Expected: FAIL (`report.claims` undefined; `getEmissionsDue`/`recordActivity`/`recordClaim`/`seenClaimsFor` not on deps).

- [ ] **Step 3: Implement in `src/runtime/cycle.ts`**

Extend imports, `CycleDeps`, the report type, build activity entries for votes/mints, and add the claim phase. Imports:

```ts
import type { ExecResult } from '../wallet/intents.js'
import type { ClaimableEmission } from '../reppo/queryEmissionsDue.js'
import type { ActivityEntry } from '../dashboard/activityLog.js'
```

`CycleDeps` additions:

```ts
  getEmissionsDue(): Promise<ClaimableEmission[]>
  seenClaimsFor(datanetId: string): Promise<Set<string>>
  recordActivity(entry: ActivityEntry): void
  recordClaim(datanetId: string, key: string): void
```

Change the report type (`config.claimEmissions` is now on `StrategyConfig`):

```ts
export interface CycleReport {
  datanets: DatanetReport[]
  claims: ExecResult[]
}
```

In the vote loop, after `votes.push(r)` and the `recordVote` guard, record activity:

```ts
          deps.recordActivity({
            ts: new Date().toISOString(), cycleId, kind: 'vote', datanetId,
            podId: intent.podId, direction: intent.direction, conviction: intent.conviction, reason: intent.reason,
            status: r.status, txHash: r.txHash, gasEth: r.gasEth, detail: r.detail,
          })
```

In the mint loop, after `mints.push(r)` and the `recordMint` guard:

```ts
          deps.recordActivity({
            ts: new Date().toISOString(), cycleId, kind: 'mint', datanetId,
            canonicalKey: intent.canonicalKey, podName: intent.podName,
            status: r.status, txHash: r.txHash, gasEth: r.gasEth, detail: r.detail,
          })
```

Accumulate per-datanet results into a `datanets` array (replace the existing `report.push(...)` in BOTH the success and catch branches with `datanets.push(...)`), then add the claim phase and return the new shape:

```ts
  const datanets: DatanetReport[] = []
  // ... existing per-datanet loop body unchanged EXCEPT:
  //     success branch:  datanets.push({ datanetId, votes, mints })
  //     catch branch:     datanets.push({ datanetId, votes, mints, error })

  const claims: ExecResult[] = []
  if (config.claimEmissions) {
    let due: ClaimableEmission[] = []
    try {
      due = await deps.getEmissionsDue()
    } catch (e) {
      console.error(`orquestra: emissions-due query failed, claim phase skipped this cycle — ${e instanceof Error ? e.message : String(e)}`)
    }
    // claimed sets are per-datanet; cache lookups to avoid re-reading per row
    const seenByDatanet = new Map<string, Set<string>>()
    for (const em of due) {
      const key = `${em.podId}:${em.epoch}`
      let seen = seenByDatanet.get(em.datanetId)
      if (!seen) { seen = await deps.seenClaimsFor(em.datanetId); seenByDatanet.set(em.datanetId, seen) }
      if (seen.has(key)) continue
      // Per-claim isolation: one failing claim never aborts the rest of the phase.
      let r: ExecResult
      try {
        r = await deps.executor.executeClaim({ kind: 'claim', datanetId: em.datanetId, podId: em.podId, epoch: em.epoch, reppoDue: em.reppo, idempotencyKey: `claim-${em.podId}-${em.epoch}` })
      } catch (e) {
        r = { ok: false, status: 'error', detail: e instanceof Error ? e.message : String(e) }
      }
      claims.push(r)
      deps.recordActivity({
        ts: new Date().toISOString(), cycleId, kind: 'claim', datanetId: em.datanetId,
        podId: em.podId, epoch: em.epoch, reppoClaimed: em.reppo,
        status: r.status, txHash: r.txHash, gasEth: r.gasEth, detail: r.detail,
      })
      // Fail-safe like vote/mint: record unless clearly refused (budget), so a landed-
      // but-unconfirmed claim isn't re-attempted. Also mark in-memory `seen` so a
      // duplicate (pod,epoch) within the same `due` list isn't re-claimed this cycle.
      if (r.status !== 'refused-budget') { deps.recordClaim(em.datanetId, key); seen.add(key) }
    }
  }

  return { datanets, claims }
```

> The executor call is wrapped in try/catch here in addition to the executor's own handling, because the test injects a rejecting `executeClaim`. Real `executeClaim` returns an `ExecResult` rather than throwing; the cycle stays robust to either.

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- --run src/runtime/cycle.test.ts`
Expected: PASS (existing tests updated to read `report.datanets` + 3 new claim tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/cycle.ts src/runtime/cycle.test.ts
git commit -m "feat(runtime): cycle claim phase + per-action activity recording; report={datanets,claims}"
```

---

# Phase B — Dashboard

### Task 10: `queryVotingPower` wrapper + parser

**Files:**
- Create: `src/reppo/queryVotingPower.ts`
- Test: `src/reppo/queryVotingPower.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/reppo/queryVotingPower.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseVotingPower } from './queryVotingPower.js'

describe('parseVotingPower', () => {
  it('extracts power + lockup count from {raw,formatted} shape', () => {
    expect(parseVotingPower({ votingPower: { formatted: '500.0' }, lockupCount: 2 }))
      .toEqual({ power: 500, lockupCount: 2 })
  })
  it('handles plain-number and missing fields', () => {
    expect(parseVotingPower({ votingPower: 250 })).toEqual({ power: 250, lockupCount: 0 })
    expect(parseVotingPower(null)).toEqual({ power: 0, lockupCount: 0 })
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --run src/reppo/queryVotingPower.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/reppo/queryVotingPower.ts`**

```ts
// src/reppo/queryVotingPower.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { reppoEnv, withRpcUrl } from './exec.js'

const execFileAsync = promisify(execFile)

export interface VotingPower { power: number; lockupCount: number }

const toFinite = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const formattedNum = (v: unknown): number => {
  if (v && typeof v === 'object' && 'formatted' in (v as Record<string, unknown>)) return toFinite((v as Record<string, unknown>).formatted)
  return toFinite(v)
}

/** Pure: extract VotingPower from `reppo query voting-power --json`. */
export function parseVotingPower(raw: unknown): VotingPower {
  const d = (raw as Record<string, unknown>) ?? {}
  return { power: formattedNum(d?.votingPower ?? d?.power), lockupCount: toFinite(d?.lockupCount) }
}

export async function queryVotingPowerJson(): Promise<VotingPower> {
  const { stdout } = await execFileAsync('reppo', withRpcUrl(['query', 'voting-power', '--json']), {
    env: reppoEnv(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  })
  try { return parseVotingPower(JSON.parse(stdout)) } catch { throw new Error(`queryVotingPowerJson: bad reppo output: ${stdout.slice(0, 200)}`) }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- --run src/reppo/queryVotingPower.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/reppo/queryVotingPower.ts src/reppo/queryVotingPower.test.ts
git commit -m "feat(reppo): queryVotingPower wrapper + parseVotingPower"
```

---

### Task 11: Snapshot (write/read/collect)

**Files:**
- Create: `src/dashboard/snapshot.ts`
- Test: `src/dashboard/snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/snapshot.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSnapshot, readSnapshot, collectSnapshot, type Snapshot } from './snapshot.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-snap-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  ts: '2026-06-03T21:38:40.000Z', cycleId: 'c1',
  balance: { eth: 0.4, reppo: 1850, veReppo: 500, usdc: 0 },
  votingPower: { power: 500, lockupCount: 1 },
  emissionsDue: { totalReppo: 0, pods: [] },
  budget: { mintReppoSpent: 100, mintGasSpentEth: 0.003, voteGasSpentEth: 0.001, claimGasSpentEth: 0.0007,
    caps: { voteGasEthMax: 0.05, voteRateMaxPerCycle: 30, mintReppoMax: 500, mintGasEthMax: 0.05, claimGasEthMax: 0.05 } },
  ...over,
})

describe('snapshot', () => {
  it('write then read round-trips', () => {
    writeSnapshot(dir, snap())
    expect(readSnapshot(dir)?.balance.reppo).toBe(1850)
  })

  it('readSnapshot returns null when absent', () => {
    expect(readSnapshot(dir)).toBeNull()
  })

  it('collectSnapshot merges over the last snapshot when a sub-call fails', async () => {
    writeSnapshot(dir, snap({ balance: { eth: 9, reppo: 9, veReppo: 9, usdc: 9 } }))
    const result = await collectSnapshot(dir, 'c2', {
      balance: async () => { throw new Error('rpc') },          // fails → keep prior 9s
      votingPower: async () => ({ power: 600, lockupCount: 2 }),
      emissionsDue: async () => ({ totalReppo: 0, pods: [] }),
      budget: () => snap().budget,
    })
    expect(result.balance.reppo).toBe(9)        // retained from prior snapshot
    expect(result.votingPower.power).toBe(600)  // fresh
    expect(result.cycleId).toBe('c2')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --run src/dashboard/snapshot.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/dashboard/snapshot.ts`**

```ts
// src/dashboard/snapshot.ts
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WalletBalance } from '../reppo/queryBalance.js'
import type { VotingPower } from '../reppo/queryVotingPower.js'
import type { EmissionsDue } from '../reppo/queryEmissionsDue.js'
import type { BudgetCaps } from '../wallet/ledger.js'

export interface SnapshotBudget {
  mintReppoSpent: number
  mintGasSpentEth: number
  voteGasSpentEth: number
  claimGasSpentEth: number
  caps: BudgetCaps
}
export interface Snapshot {
  ts: string
  cycleId: string
  balance: WalletBalance
  votingPower: VotingPower
  emissionsDue: EmissionsDue
  budget: SnapshotBudget
}

const FILE = 'snapshot.json'

export function writeSnapshot(dataDir: string, snap: Snapshot): void {
  const path = join(dataDir, FILE)
  writeFileSync(`${path}.tmp`, JSON.stringify(snap, null, 2)); renameSync(`${path}.tmp`, path)
}

export function readSnapshot(dataDir: string): Snapshot | null {
  const path = join(dataDir, FILE)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf-8')) as Snapshot } catch { return null }
}

export interface SnapshotReaders {
  balance(): Promise<WalletBalance>
  votingPower(): Promise<VotingPower>
  emissionsDue(): Promise<EmissionsDue>
  budget(): SnapshotBudget
}

/** Build a snapshot from live readers, MERGING over the last one: a sub-call that
 *  throws keeps the previous value rather than blanking it. Always resolves. */
export async function collectSnapshot(dataDir: string, cycleId: string, readers: SnapshotReaders): Promise<Snapshot> {
  const prev = readSnapshot(dataDir)
  const safe = async <T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> => {
    try { return await fn() } catch (e) {
      console.error(`orquestra: snapshot ${label} failed, keeping previous value — ${e instanceof Error ? e.message : String(e)}`)
      return fallback
    }
  }
  const balance = await safe(readers.balance, prev?.balance ?? { eth: 0, reppo: 0, veReppo: 0, usdc: 0 }, 'balance')
  const votingPower = await safe(readers.votingPower, prev?.votingPower ?? { power: 0, lockupCount: 0 }, 'votingPower')
  const emissionsDue = await safe(readers.emissionsDue, prev?.emissionsDue ?? { totalReppo: 0, pods: [] }, 'emissionsDue')
  const ts = new Date().toISOString()
  return { ts, cycleId, balance, votingPower, emissionsDue, budget: readers.budget() }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- --run src/dashboard/snapshot.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/snapshot.ts src/dashboard/snapshot.test.ts
git commit -m "feat(dashboard): snapshot write/read + collectSnapshot (merge-on-partial)"
```

---

### Task 12: PnL derivation

**Files:**
- Create: `src/dashboard/pnl.ts`
- Test: `src/dashboard/pnl.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/pnl.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { derivePnl } from './pnl.js'
import type { Snapshot } from './snapshot.js'
import type { ActivityEntry } from './activityLog.js'

const snapshot: Snapshot = {
  ts: 't', cycleId: 'c1',
  balance: { eth: 0.4, reppo: 1850, veReppo: 500, usdc: 0 },
  votingPower: { power: 500, lockupCount: 1 },
  emissionsDue: { totalReppo: 5, pods: [{ podId: '9', datanetId: '9', epoch: 101, reppo: 5 }] },
  budget: { mintReppoSpent: 100, mintGasSpentEth: 0.003, voteGasSpentEth: 0.001, claimGasSpentEth: 0.0007,
    caps: { voteGasEthMax: 0.05, voteRateMaxPerCycle: 30, mintReppoMax: 500, mintGasEthMax: 0.05, claimGasEthMax: 0.05 } },
}
const a = (over: Partial<ActivityEntry>): ActivityEntry => ({ ts: 't', cycleId: 'c1', kind: 'claim', datanetId: '9', status: 'executed', ...over })

describe('derivePnl', () => {
  it('sums executed claims for claimedReppo and adds claimable for earned', () => {
    const activity = [a({ reppoClaimed: 100 }), a({ reppoClaimed: 63 }), a({ reppoClaimed: 50, status: 'error' })]
    const p = derivePnl(snapshot, activity)
    expect(p.claimedReppo).toBe(163)      // only executed claims
    expect(p.claimableReppo).toBe(5)      // snapshot.emissionsDue.totalReppo
    expect(p.earnedReppo).toBe(168)       // 163 + 5
    expect(p.spentReppo).toBe(100)        // mintReppoSpent
    expect(p.netReppo).toBe(68)           // 168 - 100
    expect(p.gasSpentEth).toBeCloseTo(0.0047) // 0.003 + 0.001 + 0.0007
  })

  it('handles empty activity', () => {
    const p = derivePnl(snapshot, [])
    expect(p.claimedReppo).toBe(0)
    expect(p.earnedReppo).toBe(5)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --run src/dashboard/pnl.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/dashboard/pnl.ts`**

```ts
// src/dashboard/pnl.ts
import type { Snapshot } from './snapshot.js'
import type { ActivityEntry } from './activityLog.js'

export interface Pnl {
  claimedReppo: number
  claimableReppo: number
  earnedReppo: number
  spentReppo: number
  netReppo: number
  gasSpentEth: number
}

/** Pure PnL summary. claimed = Σ executed claim amounts in the log; claimable =
 *  still-unclaimed emissions in the latest snapshot; spent = REPPO on mints. */
export function derivePnl(snapshot: Snapshot, activity: ActivityEntry[]): Pnl {
  const claimedReppo = activity
    .filter((e) => e.kind === 'claim' && e.status === 'executed')
    .reduce((s, e) => s + (e.reppoClaimed ?? 0), 0)
  const claimableReppo = snapshot.emissionsDue.totalReppo
  const earnedReppo = claimedReppo + claimableReppo
  const spentReppo = snapshot.budget.mintReppoSpent
  const gasSpentEth = snapshot.budget.mintGasSpentEth + snapshot.budget.voteGasSpentEth + snapshot.budget.claimGasSpentEth
  return { claimedReppo, claimableReppo, earnedReppo, spentReppo, netReppo: earnedReppo - spentReppo, gasSpentEth }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- --run src/dashboard/pnl.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/pnl.ts src/dashboard/pnl.test.ts
git commit -m "feat(dashboard): pure derivePnl (claimed+claimable vs spend)"
```

---

### Task 13: HTTP server + static page

**Files:**
- Create: `src/dashboard/server.ts`
- Create: `src/dashboard/index.html`
- Test: `src/dashboard/server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/server.test.ts`. It starts the server on an ephemeral port (`0`), fetches each route, and asserts shapes + no secret leak:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDashboard, type DashboardHandle } from './server.js'
import { appendActivity } from './activityLog.js'

let dir: string
let handle: DashboardHandle
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orq-srv-'))
  writeFileSync(join(dir, 'strategy.config.json'), JSON.stringify({
    horizonDays: 30, cadenceHours: 1, claimEmissions: true,
    stake: { lockReppo: 0, lockDurationDays: 30 },
    budget: { voteGasEthMax: 0.05, voteRateMaxPerCycle: 30, mintReppoMax: 500, mintGasEthMax: 0.05, claimGasEthMax: 0.05 },
    datanets: { '9': { vote: true, mint: false, strictness: 'balanced' } }, notes: '',
  }))
  appendActivity(dir, { ts: 't', cycleId: 'c1', kind: 'vote', datanetId: '9', podId: '1', direction: 'up', conviction: 9, reason: 'r', status: 'executed', txHash: '0x1' })
  handle = await startDashboard(dir, 0)
})
afterEach(async () => { await handle.close(); rmSync(dir, { recursive: true, force: true }) })

const get = async (path: string) => {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`)
  return { status: res.status, body: await res.text() }
}

describe('dashboard server', () => {
  it('serves html at /', async () => {
    const r = await get('/')
    expect(r.status).toBe(200)
    expect(r.body.toLowerCase()).toContain('orquestra')
  })
  it('/api/activity returns recorded entries', async () => {
    const r = await get('/api/activity')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)[0].podId).toBe('1')
  })
  it('/api/pnl returns a {pnl,snapshot} object (null snapshot tolerated)', async () => {
    const r = await get('/api/pnl')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toHaveProperty('pnl')
  })
  it('/api/config strips secrets', async () => {
    const r = await get('/api/config')
    expect(r.status).toBe(200)
    expect(r.body).not.toMatch(/PRIVATE_KEY|inf_|0x[a-fA-F0-9]{64}/)
    expect(JSON.parse(r.body)).toHaveProperty('cadenceHours')
  })
  it('unknown path → 404', async () => {
    expect((await get('/nope')).status).toBe(404)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --run src/dashboard/server.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the static page `src/dashboard/index.html`**

A single self-contained page (vanilla JS; fetches the three endpoints; no framework, no build). The string "Orquestra" must appear in the markup (the `/` test asserts it):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Orquestra</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; background: #0b0e14; color: #d7dce5; }
  header { padding: 16px 24px; border-bottom: 1px solid #1c2230; display: flex; justify-content: space-between; align-items: baseline; }
  h1 { font-size: 18px; margin: 0; } .muted { color: #7d8799; font-size: 12px; }
  main { padding: 24px; max-width: 1100px; margin: 0 auto; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #121620; border: 1px solid #1c2230; border-radius: 8px; padding: 14px; }
  .card .k { color: #7d8799; font-size: 12px; } .card .v { font-size: 20px; font-weight: 600; margin-top: 4px; }
  .pos { color: #5ad19b; } .neg { color: #e5707e; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #1c2230; font-variant-numeric: tabular-nums; }
  th { color: #7d8799; font-weight: 500; font-size: 12px; }
  .pill { padding: 1px 8px; border-radius: 999px; font-size: 11px; }
  .up { background: #163a2b; color: #5ad19b; } .down { background: #3a1620; color: #e5707e; }
  .mint { background: #1c2a3a; color: #6fb3e8; } .claim { background: #2a2440; color: #b39ae5; }
  .err { color: #e5707e; } select { background: #121620; color: #d7dce5; border: 1px solid #1c2230; border-radius: 6px; padding: 4px; }
  a { color: #6fb3e8; }
</style>
</head>
<body>
<header>
  <h1>Orquestra <span class="muted" id="sub"></span></h1>
  <span class="muted" id="asof"></span>
</header>
<main>
  <div class="cards" id="cards"></div>
  <h2 style="font-size:15px">Claimable emissions</h2>
  <table id="emTable"><thead><tr><th>Pod</th><th>Datanet</th><th>Epoch</th><th>REPPO</th></tr></thead><tbody></tbody></table>
  <h2 style="font-size:15px">Activity
    <select id="kind"><option value="">all</option><option>vote</option><option>mint</option><option>claim</option></select>
  </h2>
  <table id="actTable"><thead><tr><th>Time</th><th>Kind</th><th>Datanet</th><th>Pod</th><th>Detail</th><th>Status</th><th>Tx</th></tr></thead><tbody></tbody></table>
</main>
<script>
const fmt = (n) => (n === undefined || n === null) ? '—' : (Math.round(n * 10000) / 10000).toLocaleString()
const sign = (n) => n > 0 ? 'pos' : n < 0 ? 'neg' : ''
async function load() {
  const [pnlRes, act, cfg] = await Promise.all([
    fetch('/api/pnl').then(r => r.json()),
    fetch('/api/activity').then(r => r.json()),
    fetch('/api/config').then(r => r.json()),
  ])
  const p = pnlRes.pnl, snap = pnlRes.snapshot
  document.getElementById('sub').textContent = `· ${cfg.cadenceHours}h cadence · claim ${cfg.claimEmissions ? 'on' : 'off'}`
  document.getElementById('asof').textContent = snap ? `as of ${new Date(snap.ts).toLocaleString()}` : 'PnL pending first cycle'
  const cards = [
    ['Net REPPO', p ? `<span class="${sign(p.netReppo)}">${fmt(p.netReppo)}</span>` : '—'],
    ['Earned', p ? fmt(p.earnedReppo) : '—'], ['Claimed', p ? fmt(p.claimedReppo) : '—'],
    ['Claimable', p ? fmt(p.claimableReppo) : '—'], ['Spent (mint)', p ? fmt(p.spentReppo) : '—'],
    ['Gas (ETH)', p ? fmt(p.gasSpentEth) : '—'],
    ['REPPO bal', snap ? fmt(snap.balance.reppo) : '—'], ['veREPPO', snap ? fmt(snap.balance.veReppo) : '—'],
  ]
  document.getElementById('cards').innerHTML = cards.map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')
  const em = snap ? snap.emissionsDue.pods : []
  document.querySelector('#emTable tbody').innerHTML = em.length
    ? em.map(e => `<tr><td>${e.podId}</td><td>${e.datanetId}</td><td>${e.epoch}</td><td>${fmt(e.reppo)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">none — all claimed</td></tr>'
  window._activity = act
  renderActivity()
}
function renderActivity() {
  const kind = document.getElementById('kind').value
  const rows = (window._activity || []).filter(r => !kind || r.kind === kind)
  const detail = (r) => r.kind === 'vote' ? `${r.direction} · conv ${r.conviction} · ${r.reason ?? ''}`
    : r.kind === 'mint' ? (r.podName ?? r.canonicalKey ?? '')
    : `epoch ${r.epoch} · ${fmt(r.reppoClaimed)} REPPO`
  const tx = (r) => r.txHash ? `<a href="https://basescan.org/tx/${r.txHash}" target="_blank">${r.txHash.slice(0,8)}…</a>` : ''
  document.querySelector('#actTable tbody').innerHTML = rows.length
    ? rows.map(r => `<tr><td>${new Date(r.ts).toLocaleTimeString()}</td><td><span class="pill ${r.kind === 'vote' ? r.direction : r.kind}">${r.kind}</span></td><td>${r.datanetId}</td><td>${r.podId ?? ''}</td><td>${detail(r)}</td><td class="${r.status === 'executed' ? '' : 'err'}">${r.status}</td><td>${tx(r)}</td></tr>`).join('')
    : '<tr><td colspan="7" class="muted">no activity yet</td></tr>'
}
document.getElementById('kind').addEventListener('change', renderActivity)
load().catch(e => document.getElementById('asof').textContent = 'load error: ' + e.message)
setInterval(load, 30000)
</script>
</body>
</html>
```

- [ ] **Step 4: Implement `src/dashboard/server.ts`**

Reads files only. Never imports the executor/CLI-signing or the private key. Loads `index.html` relative to the compiled file via `import.meta.url`.

```ts
// src/dashboard/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readActivity } from './activityLog.js'
import { readSnapshot } from './snapshot.js'
import { derivePnl } from './pnl.js'

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), 'index.html')

export interface DashboardHandle { close(): Promise<void>; port: number }

/** A safe subset of strategy.config.json — explicitly whitelisted fields only. */
function safeConfig(dataDir: string): Record<string, unknown> {
  const path = join(dataDir, 'strategy.config.json')
  if (!existsSync(path)) return {}
  try {
    const c = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    return {
      horizonDays: c.horizonDays, cadenceHours: c.cadenceHours,
      claimEmissions: c.claimEmissions, datanets: c.datanets, notes: c.notes,
    }
  } catch { return {} }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
}

function handle(dataDir: string, req: IncomingMessage, res: ServerResponse): void {
  const url = (req.url ?? '/').split('?')[0]
  try {
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(existsSync(HTML_PATH) ? readFileSync(HTML_PATH, 'utf-8') : '<h1>Orquestra</h1>')
      return
    }
    if (url === '/api/activity') { json(res, 200, readActivity(dataDir, { limit: 500 })); return }
    if (url === '/api/config') { json(res, 200, safeConfig(dataDir)); return }
    if (url === '/api/pnl') {
      const snapshot = readSnapshot(dataDir)
      const activity = readActivity(dataDir, { limit: 5000 })
      const pnl = snapshot ? derivePnl(snapshot, activity) : null
      json(res, 200, { pnl, snapshot }); return
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
}

/** Start the read-only dashboard server. Binds 0.0.0.0 (docker -p maps the port);
 *  restrict exposure with `-p 127.0.0.1:7070:7070`. */
export function startDashboard(dataDir: string, port: number): Promise<DashboardHandle> {
  const server = createServer((req, res) => handle(dataDir, req, res))
  return new Promise((resolve) => {
    server.listen(port, () => {
      const actual = (server.address() as AddressInfo).port
      resolve({
        port: actual,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}
```

> Build note: `index.html` must sit next to the compiled `server.js` in `dist/dashboard/`. The runtime fallback (`<h1>Orquestra</h1>`) keeps the server functional if the copy is missing, but the page should ship — Task 14 Step 3 adds the asset copy to the build.

- [ ] **Step 5: Run tests to confirm they pass**

Run: `npm test -- --run src/dashboard/server.test.ts`
Expected: PASS (5 tests). During vitest, `index.html` resolves relative to the `src/` file, so `/` returns the real page; if not found, the stub still contains "Orquestra" and the test passes.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/server.ts src/dashboard/index.html src/dashboard/server.test.ts
git commit -m "feat(dashboard): read-only http server + static page"
```

---

### Task 14: Wire into `index.ts` + env + Docker

**Files:**
- Modify: `src/index.ts`
- Modify: `Dockerfile`
- Modify: `.env.example`
- Modify: `package.json` (asset copy for `index.html` if `tsc`-only build)

- [ ] **Step 1: Wire the cycle callback + dashboard in `src/index.ts`**

Add imports:

```ts
import { appendActivity } from './dashboard/activityLog.js'
import { collectSnapshot, writeSnapshot, type SnapshotBudget } from './dashboard/snapshot.js'
import { queryVotingPowerJson } from './reppo/queryVotingPower.js'
import { queryEmissionsDueJson } from './reppo/queryEmissionsDue.js'
import { startDashboard } from './dashboard/server.js'
```

Extend the `CycleDeps` object built in `start()` with the new callbacks (alongside the existing `recordVote`/`recordMint`):

```ts
    getEmissionsDue: () => queryEmissionsDueJson(),
    seenClaimsFor: async (id) => new Set(dedup.getClaimedKeys(id)),
    recordActivity: (entry) => {
      try { appendActivity(DATA_DIR, entry) } catch (e) { console.error(`orquestra: activity append failed (non-fatal): ${(e as Error).message}`) }
    },
    recordClaim: (id, key) => dedup.recordClaim(id, key),
```

Replace the scheduler tick body to (a) use the new `{ datanets, claims }` report shape, (b) write the snapshot after the cycle:

```ts
  const handle = startScheduler(config.cadenceHours, async () => {
    const cycleId = new Date().toISOString()
    const report = await runCycle(config, cycleId, deps)
    const v = report.datanets.reduce((a, r) => a + r.votes.length, 0)
    const m = report.datanets.reduce((a, r) => a + r.mints.length, 0)
    const c = report.claims.length
    console.error(`orquestra: cycle ${cycleId} — ${v} votes, ${m} mints, ${c} claims executed`)

    // Snapshot the on-chain view for the dashboard (best-effort; never throws into the loop).
    try {
      const budget: SnapshotBudget = {
        mintReppoSpent: ledger.state.mintReppoSpent,
        mintGasSpentEth: ledger.state.mintGasSpentEth,
        voteGasSpentEth: ledger.state.voteGasSpentEth,
        claimGasSpentEth: ledger.state.claimGasSpentEth,
        caps: config.budget,
      }
      const snap = await collectSnapshot(DATA_DIR, cycleId, {
        balance: () => queryBalanceJson(),
        votingPower: () => queryVotingPowerJson(),
        emissionsDue: () => queryEmissionsDueJson(),
        budget: () => budget,
      })
      writeSnapshot(DATA_DIR, snap)
    } catch (e) {
      console.error(`orquestra: snapshot write failed (non-fatal): ${(e as Error).message}`)
    }
  })
```

Start the dashboard after the scheduler and include it in shutdown:

```ts
  const dashEnabled = (process.env.DASHBOARD_ENABLED ?? 'true') !== 'false'
  const dashPort = Number(process.env.DASHBOARD_PORT ?? 7070)
  const dash = dashEnabled ? await startDashboard(DATA_DIR, dashPort) : null
  if (dash) console.error(`orquestra: dashboard on http://localhost:${dash.port}`)

  const shutdown = (sig: string): void => {
    console.error(`\norquestra: received ${sig} — stopping scheduler and exiting.`)
    handle.stop()
    if (dash) void dash.close()
    process.exit(0)
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
```

(`queryBalanceJson` is already imported in `index.ts`; `ledger` is already in scope.)

- [ ] **Step 2: Typecheck + full suite**

Run: `npm run typecheck && npm test -- --run`
Expected: PASS. Fix any remaining references to the old `CycleReport` array shape (grep: `report.reduce`, other `report.` consumers).

- [ ] **Step 3: Ensure `index.html` ships to `dist/`**

Read `package.json`'s `build` script. If it is `tsc`-only (which does not copy `.html`), add a copy so the page is available at runtime:

```json
  "scripts": {
    "build": "tsc && cp src/dashboard/index.html dist/dashboard/index.html"
  }
```

(If a bundler/asset step already copies non-TS files, skip this.) Run `npm run build` and confirm `dist/dashboard/index.html` exists.

- [ ] **Step 4: Update `Dockerfile`**

Add `EXPOSE 7070` near the existing `ENV`/`ENTRYPOINT`. Confirm the build stage that runs `npm run build` produces `dist/dashboard/index.html` (Step 3) and that the final image's copy of `dist/` includes it.

- [ ] **Step 5: Update `.env.example`**

Append:

```
# Dashboard (read-only) served inside the container.
DASHBOARD_ENABLED=true
DASHBOARD_PORT=7070
# Run with `-p 127.0.0.1:7070:7070` to expose it ONLY to your machine's localhost.
```

- [ ] **Step 6: Build the image + smoke-test the dashboard**

```bash
docker build -t orquestra .
docker run -d --name orq-dash --env-file .env -p 127.0.0.1:7070:7070 -v "$HOME/code/orquestra/orquestra-data:/data" orquestra
sleep 5
curl -s http://127.0.0.1:7070/api/config
curl -s http://127.0.0.1:7070/api/pnl | head -c 300
docker rm -f orq-dash
```

Expected: `/api/config` returns JSON with `cadenceHours` and no secrets; `/api/pnl` returns `{"pnl":...,"snapshot":...}` (pnl may be null before the first cycle completes).

- [ ] **Step 7: Commit**

```bash
git add src/index.ts Dockerfile .env.example package.json
git commit -m "feat(dashboard): wire activity log + snapshot + http server into the node"
```

---

## Final verification (after all tasks)

- [ ] `npm run typecheck` → clean
- [ ] `npm run build` → clean; `dist/dashboard/index.html` exists
- [ ] `npm test -- --run` → all green
- [ ] `docker build -t orquestra .` → succeeds
- [ ] Dispatch a final code review over the whole branch (staked-capital safety: confirm the claim phase's reserve-before-sign + fail-safe recording, and that the dashboard server imports neither the executor nor the private key).

## Notes for the implementer

- **Report shape change is the riskiest edit.** `CycleReport` goes from `DatanetReport[]` to `{ datanets, claims }`. Grep for every consumer (`index.ts`, `cycle.test.ts`) and update them in the same task (Task 9 / Task 14).
- **Claim fail-safe matches vote/mint:** record the (pod,epoch) in `claimedKeys` unless the result is `refused-budget`, so a landed-but-unconfirmed claim is never re-attempted.
- **The dashboard is read-only.** If a reviewer finds it importing `WalletExecutor`, `defaultReppoCli`, or anything that reads `REPPO_PRIVATE_KEY`, that's a defect.
- **CLI JSON shapes** for `query emissions-due` and `query voting-power` are assumed from the 0.5.0 help + the `{raw,formatted}` convention; confirm against 0.7.0 output at Task 7/10 integration and adjust the pure parsers' field names if needed (the tests pin the parser contract, not the live shape).
```
