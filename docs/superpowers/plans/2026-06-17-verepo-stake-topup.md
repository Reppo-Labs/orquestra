# veREPPO Stake Top-Up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `config.stake.lockReppo` a live target — when it exceeds the wallet's current veREPPO, lock the difference (an additional lockup), applied at startup AND mid-run (next cycle, no restart).

**Architecture:** A pure `planStakeTopUp(current, stake)` decides lock-the-difference vs skip. `setupNode` (startup) and a new `maybeTopUpStake` step at the top of `runCycle` (per cycle, on hot-reloaded config) both call it + `executor.lock` with a target-based idempotency key. A per-cycle in-memory guard + the idempotency key prevent re-lock spam. Amount-only (extending an existing lock's duration is impossible — VeReppo isn't ERC721-enumerable). No reppo-cli / contract change.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import extensions), vitest. Web: React+Vite (for the activity badge).

**Spec:** `docs/superpowers/specs/2026-06-17-verepo-stake-topup-design.md`

> Worktree root: `/Users/anajuliabittencourt/code/orquestra/.claude/worktrees/nifty-munching-waffle`. Branch `feat/verepo-stake-topup` (already created). Run from root.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/wallet/stakeTopUp.ts` | create | Pure `planStakeTopUp(current, stake) → {lockAmount,durationSeconds} \| null` + `stakeTopUpKey`. |
| `src/wallet/stakeTopUp.test.ts` | create | Table-driven tests for the planner. |
| `src/index.ts` | modify | `setupNode` tops up to target (replaces skip-if-veREPPO>0). |
| `src/runtime/cycle.ts` | modify | `CycleDeps.getVeReppo`; `maybeTopUpStake` step at top of `runCycle`; per-cycle guard. |
| `src/runtime/wiring.ts` | modify | Provide `getVeReppo` in `buildCycleDeps`. |
| `src/dashboard/activityLog.ts` | modify | Add `'stake'` to the `ActivityEntry` kind union. |
| `src/dashboard/health.ts` | modify | Exclude `'stake'` from health buckets (like `'grant'`). |
| `web/src/api.ts` | modify | Add `'stake'` to the activity `kind` union. |
| `web/src/components/Activity.tsx` + `web/src/styles.css` | modify | Render + style the `stake` pill. |

---

### Task 1: Pure `planStakeTopUp`

**Files:**
- Create: `src/wallet/stakeTopUp.ts`
- Test: `src/wallet/stakeTopUp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/wallet/stakeTopUp.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planStakeTopUp } from './stakeTopUp.js'

describe('planStakeTopUp', () => {
  it('locks the difference when the target exceeds current veREPPO', () => {
    expect(planStakeTopUp(1031, { lockReppo: 2000, lockDurationDays: 30 }))
      .toEqual({ lockAmount: 969, durationSeconds: 30 * 86400 })
  })
  it('locks the full target from zero (first lock)', () => {
    expect(planStakeTopUp(0, { lockReppo: 2000, lockDurationDays: 30 }))
      .toEqual({ lockAmount: 2000, durationSeconds: 30 * 86400 })
  })
  it('returns null when current is at or above target (incl. down-bump)', () => {
    expect(planStakeTopUp(2000, { lockReppo: 2000, lockDurationDays: 30 })).toBeNull()
    expect(planStakeTopUp(2500, { lockReppo: 2000, lockDurationDays: 30 })).toBeNull()
  })
  it('returns null when staking is not configured (target <= 0)', () => {
    expect(planStakeTopUp(0, { lockReppo: 0, lockDurationDays: 30 })).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/wallet/stakeTopUp.test.ts`
Expected: FAIL — module `./stakeTopUp.js` not found.

- [ ] **Step 3: Implement**

Create `src/wallet/stakeTopUp.ts`:

```ts
/** Plan a veREPPO top-up: when the configured target `stake.lockReppo` exceeds the
 *  wallet's current veREPPO, lock the difference as an additional lockup (aggregate
 *  veREPPO = sum of lockups). Returns null when staking is off (target <= 0) or the
 *  wallet is already at/above target (incl. a down-bump — locks can't be reduced).
 *  Amount-only: a new lockup gets `lockDurationDays`; existing lockups keep their
 *  expiry (extending them is impossible — VeReppo is not ERC721-enumerable). */
export function planStakeTopUp(
  currentVeReppo: number,
  stake: { lockReppo: number; lockDurationDays: number },
): { lockAmount: number; durationSeconds: number } | null {
  if (stake.lockReppo <= 0) return null
  if (currentVeReppo >= stake.lockReppo) return null
  return {
    lockAmount: stake.lockReppo - currentVeReppo,
    durationSeconds: stake.lockDurationDays * 86400,
  }
}

/** Stable idempotency key for a top-up to a given target — a crash-retry before the
 *  lock tx lands reuses it (no double-lock); a later further bump uses a new key. */
export function stakeTopUpKey(stake: { lockReppo: number; lockDurationDays: number }): string {
  return `lock-target-${stake.lockReppo}-${stake.lockDurationDays}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/wallet/stakeTopUp.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/wallet/stakeTopUp.ts src/wallet/stakeTopUp.test.ts
git commit -m "feat(wallet): planStakeTopUp helper (lock the difference to the target)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `setupNode` tops up to target at startup

**Files:**
- Modify: `src/index.ts` (`setupNode`, lines 75-90)

- [ ] **Step 1: Replace the skip-if-veREPPO>0 branch**

The current body (lines 76-90):

```ts
  if (config.stake.lockReppo > 0) {
    // Idempotent: the veREPPO lock is one-time. If the wallet already holds veREPPO
    // (locked on a prior run), skip — re-locking would just error every restart.
    const existing = await queryBalanceJson().catch(() => null)
    if (existing && existing.veReppo > 0) {
      console.error(`orquestra: already holding ${existing.veReppo} veREPPO — skipping lock.`)
    } else {
      const r = await executor.lock({
        amountReppo: config.stake.lockReppo,
        durationSeconds: config.stake.lockDurationDays * 86400,
        idempotencyKey: `lock-${config.stake.lockReppo}-${config.stake.lockDurationDays}`,
      })
      console.error(`orquestra: veREPPO lock ${r.status}` + (r.txHash ? ` (${r.txHash})` : '') + (r.detail ? ` — ${r.detail}` : ''))
    }
  }
```

Replace with (top-up to target; tolerant balance read; non-fatal on lock error):

```ts
  if (config.stake.lockReppo > 0) {
    // The lock is a TARGET, not one-time: top up to config.stake.lockReppo by locking
    // the difference as an additional lockup. Skip when already at/above target. A lock
    // error is non-fatal — the node still runs/votes on existing veREPPO.
    const existing = await queryBalanceJson().catch(() => null)
    const current = existing?.veReppo ?? 0
    const plan = planStakeTopUp(current, config.stake)
    if (!plan) {
      console.error(`orquestra: veREPPO ${current} ≥ target ${config.stake.lockReppo} — no lock needed.`)
    } else {
      console.error(`orquestra: topping up veREPPO ${current} → ${config.stake.lockReppo} (+${plan.lockAmount}, ${config.stake.lockDurationDays}d)`)
      const r = await executor.lock({
        amountReppo: plan.lockAmount,
        durationSeconds: plan.durationSeconds,
        idempotencyKey: stakeTopUpKey(config.stake),
      })
      console.error(`orquestra: veREPPO lock ${r.status}` + (r.txHash ? ` (${r.txHash})` : '') + (r.detail ? ` — ${r.detail}` : ''))
    }
  }
```

Add the import near the other wallet imports: `import { planStakeTopUp, stakeTopUpKey } from './wallet/stakeTopUp.js'`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(setup): veREPPO lock tops up to the config target at startup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `'stake'` activity kind (dashboard breadcrumb)

**Files:**
- Modify: `src/dashboard/activityLog.ts` (kind union), `src/dashboard/health.ts` (exclude)
- Modify: `web/src/api.ts` (kind union), `web/src/components/Activity.tsx` + `web/src/styles.css`

- [ ] **Step 1: Backend kind union + health exclusion**

In `src/dashboard/activityLog.ts`, find the `ActivityEntry` `kind` union (currently `'vote' | 'mint' | 'skip' | 'claim' | 'grant'`) and add `'stake'`:

```ts
  kind: 'vote' | 'mint' | 'skip' | 'claim' | 'grant' | 'stake'
```

In `src/dashboard/health.ts`, the loop already does `if (e.kind === 'grant') continue` to exclude setup breadcrumbs from tx-rate/skip buckets. Extend it to also skip `'stake'`:

```ts
    if (e.kind === 'grant' || e.kind === 'stake') continue
```

(Read the exact line — the early-continue that precedes the `bucket = e.kind === 'vote' ? ...` dispatch; match its current form and add `'stake'`.)

- [ ] **Step 2: Web kind union + pill**

In `web/src/api.ts`, the `ActivityRow.kind` union (currently `... | 'grant'`) gains `'stake'`:

```ts
  kind: 'vote' | 'mint' | 'skip' | 'claim' | 'grant' | 'stake'
```

In `web/src/components/Activity.tsx`, the `pillClass`/filter already handle `'grant'`; ensure `'stake'` renders (the existing `r.kind` fallthrough yields `className="pill stake"`; add a filter option if the file enumerates kinds — mirror how `'grant'` was added). In `web/src/styles.css`, add a `.pill.stake` rule mirroring `.pill.grant`/`.pill.claim` (read those and copy the color treatment).

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm --prefix web run typecheck && npm --prefix web run build`
Expected: clean; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/activityLog.ts src/dashboard/health.ts web/src/api.ts web/src/components/Activity.tsx web/src/styles.css
git commit -m "feat(dashboard): 'stake' activity kind for veREPPO top-ups

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Per-cycle `maybeTopUpStake` (live, no restart)

**Files:**
- Modify: `src/runtime/cycle.ts` (`CycleDeps` + `runCycle`)
- Modify: `src/runtime/wiring.ts` (provide `getVeReppo`)
- Test: `src/runtime/cycle.test.ts`

- [ ] **Step 1: Add `getVeReppo` to `CycleDeps`**

In `src/runtime/cycle.ts`, in the `CycleDeps` interface (lines 16-45), add (near `executor` / `getEmissionsDue`):

```ts
  /** Live veREPPO balance (for stake top-up). */
  getVeReppo(): Promise<number>
```

- [ ] **Step 2: Write the failing cycle test**

Read `src/runtime/cycle.test.ts` for the existing `runCycle` harness (the `deps()`/baseDeps + `cfgWith` helpers the per-datanet tests use). Add a describe mirroring it (adapt helper names to the real ones — do NOT invent):

```ts
describe('runCycle stake top-up', () => {
  it('locks the difference when veREPPO is below the config target, once per target', async () => {
    const lock = vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xlock' }))
    const d = deps({ getVeReppo: async () => 1031, executor: { ...baseExecutor, lock } })
    const cfg = cfgWith({ stake: { lockReppo: 2000, lockDurationDays: 30 } })
    await runCycle(cfg, 'c1', d)
    await runCycle(cfg, 'c2', d) // same target → no second lock (guard)
    expect(lock).toHaveBeenCalledTimes(1)
    expect(lock.mock.calls[0][0]).toMatchObject({ amountReppo: 969, durationSeconds: 30 * 86400 })
  })

  it('does not lock when veREPPO is at/above target', async () => {
    const lock = vi.fn(async () => ({ ok: true, status: 'executed' }))
    const d = deps({ getVeReppo: async () => 2000, executor: { ...baseExecutor, lock } })
    await runCycle(cfgWith({ stake: { lockReppo: 2000, lockDurationDays: 30 } }), 'c1', d)
    expect(lock).not.toHaveBeenCalled()
  })

  it('a lock failure does not abort the cycle', async () => {
    const lock = vi.fn(async () => { throw new Error('INSUFFICIENT_REPPO_BALANCE') })
    const d = deps({ getVeReppo: async () => 0, executor: { ...baseExecutor, lock } })
    const r = await runCycle(cfgWith({ stake: { lockReppo: 2000, lockDurationDays: 30 } }), 'c1', d)
    expect(r).toBeDefined() // cycle completed despite the lock throwing
  })
})
```

NOTE: the once-per-target guard is module-level state, so the first test's two `runCycle` calls share it within the test file. Use a DISTINCT target in other tests (or reset) so cross-test state doesn't interfere — e.g. give the at/above test target 2000 with current 2000 (returns null before the guard), and the failure test a fresh target like 1500. If the file resets modules per test, no concern; otherwise pick distinct targets.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/runtime/cycle.test.ts`
Expected: FAIL — `getVeReppo` not consumed / no top-up call.

- [ ] **Step 4: Implement `maybeTopUpStake` + call it at the top of `runCycle`**

In `src/runtime/cycle.ts`, add the import + a module-level guard + helper (after imports):

```ts
import { planStakeTopUp, stakeTopUpKey } from '../wallet/stakeTopUp.js'

// Per-process latch: the target last attempted. Prevents re-locking every cycle (the
// cycle runs ~every 0.3h). Success drives veREPPO to the target so planStakeTopUp
// returns null next cycle anyway; a FAILED attempt is held off until the target changes.
let lastAttemptedStakeTarget: number | null = null

async function maybeTopUpStake(config: StrategyConfig, cycleId: string, deps: CycleDeps): Promise<void> {
  try {
    const current = await deps.getVeReppo()
    const plan = planStakeTopUp(current, config.stake)
    if (!plan) return
    if (config.stake.lockReppo === lastAttemptedStakeTarget) return // already attempted this target
    lastAttemptedStakeTarget = config.stake.lockReppo
    const r = await deps.executor.lock({
      amountReppo: plan.lockAmount,
      durationSeconds: plan.durationSeconds,
      idempotencyKey: stakeTopUpKey(config.stake),
    })
    deps.recordActivity({
      ts: new Date().toISOString(), cycleId, kind: 'stake',
      reason: `topped up veREPPO ${current} → ${config.stake.lockReppo} (+${plan.lockAmount}, ${config.stake.lockDurationDays}d)`,
      status: r.status === 'executed' ? 'executed' : 'skipped',
      ...(r.txHash ? { txHash: r.txHash } : {}),
    })
  } catch (e) {
    // Never abort the cycle on a stake top-up failure; the node runs on existing veREPPO.
    console.error(`orquestra: veREPPO top-up failed — ${e instanceof Error ? e.message : String(e)}`)
    deps.recordActivity({
      ts: new Date().toISOString(), cycleId, kind: 'stake',
      reason: `veREPPO top-up failed — ${e instanceof Error ? e.message : String(e)}`, status: 'skipped',
    })
  }
}
```

Call it at the very top of `runCycle` (after the function opens, before the datanet loop):

```ts
export async function runCycle(config: StrategyConfig, cycleId: string, deps: CycleDeps): Promise<CycleReport> {
  await maybeTopUpStake(config, cycleId, deps)
  // ... existing body unchanged ...
```

Align the `recordActivity({...})` object fields to the real `ActivityEntry` shape (read it — confirm `reason`, `status`, `txHash` are the field names; `datanetId` is optional/omitted here since a stake top-up is wallet-global, mirroring how the `claim`/`grant` wallet-global entries omit or sentinel it — match that).

- [ ] **Step 5: Wire `getVeReppo` in `buildCycleDeps`**

In `src/runtime/wiring.ts` `buildCycleDeps`, add to the returned `CycleDeps` object:

```ts
    getVeReppo: async () => (await queryBalanceJson().catch(() => null))?.veReppo ?? 0,
```

Add the import if absent: `import { queryBalanceJson } from '../reppo/queryBalance.js'`. (`setupNode` already uses `queryBalanceJson` the same way, so this needs no `index.ts` wiring change.)

- [ ] **Step 6: Run the test + full typecheck**

Run: `npx vitest run src/runtime/cycle.test.ts && npm run typecheck`
Expected: PASS — top-up locks once per target, skips at/above, a throw doesn't abort; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/cycle.ts src/runtime/wiring.ts src/runtime/cycle.test.ts
git commit -m "feat(cycle): live veREPPO top-up to target (per-cycle, guarded, fail-closed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Full gate

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS — typecheck clean; full vitest suite green (incl. stakeTopUp + cycle top-up tests); build (backend + web SPA) succeeds.

- [ ] **Step 2: Commit any fixups (only if needed)**

```bash
git add -A
git commit -m "test: fixups for veREPPO stake top-up

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Manual check (optional)**

Rebuild + redeploy (`docker build -t orquestra:latest .` then recreate). With `config.stake.lockReppo` bumped above current veREPPO and the wallet holding enough REPPO, the next cycle logs `topping up veREPPO …` and a `stake` activity entry appears; veREPPO rises toward the target; a subsequent cycle at/above target does nothing. Insufficient REPPO → a recorded `stake` skip, cycle unaffected.

---

## Self-Review

- **Spec coverage:** §1 planner → Task 1. §3 startup top-up → Task 2. §4 per-cycle `maybeTopUpStake` + guard + isolation + breadcrumb → Tasks 3-4. §5 veREPPO read (`queryBalanceJson`) → Task 4 Step 5. Testing (planner table + cycle behaviors) → Tasks 1,4 (startup logic reuses `planStakeTopUp`, covered in Task 1; `index.ts` has no unit harness — verified by typecheck). Out-of-scope (duration extension, lockup ids, CLI/contract change) → honored (none touched). ✓
  - **Simplification vs spec:** dropped the cross-file `lastAttemptedStakeTarget` *seed* from `setupNode`; the target idempotency key already makes a startup↔cycle-1 overlap a harmless cached-tx no-op, and the per-cycle latch handles steady-state. Noted; not a coverage gap.
- **Placeholder scan:** none — full code for the planner, setupNode replacement, `maybeTopUpStake`, the wiring reader; concrete test code; every run step has a command + expected result. Harness-adaptation steps name the exact existing helpers to reuse and forbid inventing.
- **Type consistency:** `planStakeTopUp(current, stake) → {lockAmount, durationSeconds} | null` + `stakeTopUpKey(stake)` defined in Task 1, consumed identically in Task 2 (setupNode) and Task 4 (`maybeTopUpStake`). `executor.lock({ amountReppo, durationSeconds, idempotencyKey })` matches the existing `LockArgs`. `getVeReppo(): Promise<number>` defined in `CycleDeps` (Task 4 Step 1), implemented in wiring (Step 5), used in `maybeTopUpStake`. `kind:'stake'` added to both backend + web unions in Task 3 before Task 4 records it. ✓
