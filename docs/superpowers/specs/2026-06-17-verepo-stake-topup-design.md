# veREPPO stake top-up to target — design

**Date:** 2026-06-17
**Status:** Approved (design); implementation pending
**Author:** Ana (with Claude Code)
**Repo:** orquestra

## Problem

Bumping `config.stake.lockReppo` in the dashboard (e.g. 1031 → 2000) does not increase
the wallet's veREPPO. `setupNode` (`src/index.ts:75-90`) locks **only when veREPPO is
0**, else logs "already holding … — skipping lock"; it never compares to the new
target or tops up, and it runs **once at startup** (not hot-reloaded). So the stake
config is effectively write-once.

Make the stake config a live **target**: when it exceeds current veREPPO, lock the
difference — applied within a cycle, no restart required.

## Constraints found (shape the scope)

- `executor.lock` → `reppo lock <amount> --duration <s>` calls `stake(amount, duration)`,
  which mints a **fresh lockup** each call (`reppo-cli abis.ts:55`). Aggregate veREPPO =
  sum of all lockups. So topping up the **amount** = locking the difference as an
  additional lockup — **no new CLI capability needed**.
- **Extending the existing lock's duration is NOT possible** and is OUT OF SCOPE:
  `VeReppo.sol` is a plain `ERC721Upgradeable` (not `ERC721Enumerable`, no
  `lockupsOf`), so a wallet's existing lockup token ids can't be enumerated, and the
  node never captured the current lockup's id at creation. A new top-up lockup gets the
  configured duration; pre-existing lockups keep their original expiry.
- `executor.lock` is **not budget-gated** (consent = the operator-set `config.stake`
  value; `src/wallet/executor.ts` "One-time veREPPO lock … Not budget-gated"). The CLI
  pre-flights `INSUFFICIENT_REPPO_BALANCE`.

## Decisions (settled during brainstorming)

1. **Amount top-up only** — lock `target − current` as an additional lockup. Duration
   extension of existing locks is out of scope (contract blocker above).
2. **Applies live (no restart)** — a per-cycle check tops up when the hot-reloaded
   config target exceeds current veREPPO. Startup also runs it (first lock / boot-time
   top-up).
3. **Retry-storm guard** — an in-memory per-process `lastAttemptedStakeTarget` prevents
   re-locking every cycle (the cycle runs ~every 0.3h).
4. **Fail-closed, never abort the cycle** — a top-up failure logs and the cycle
   proceeds (votes/mints on existing veREPPO).

## Design

### 1. Pure planner `planStakeTopUp` (`src/wallet/stakeTopUp.ts`, new)
```ts
export function planStakeTopUp(
  currentVeReppo: number,
  stake: { lockReppo: number; lockDurationDays: number },
): { lockAmount: number; durationSeconds: number } | null {
  if (stake.lockReppo <= 0) return null            // staking not configured
  if (currentVeReppo >= stake.lockReppo) return null // at/above target (incl. down-bump)
  return {
    lockAmount: stake.lockReppo - currentVeReppo,
    durationSeconds: stake.lockDurationDays * 86400,
  }
}
```
Pure + unit-tested: target>current → diff; current≥target → null; target≤0 → null;
current 0 → full target.

### 2. Shared executor call
Both triggers call `executor.lock({ amountReppo: plan.lockAmount, durationSeconds:
plan.durationSeconds, idempotencyKey: \`lock-target-${stake.lockReppo}-${stake.lockDurationDays}\` })`.
The target-based idempotency key makes a crash-retry before the tx lands reuse the same
key (no double-lock); a later further bump (new target) uses a new key.

### 3. Startup (`src/index.ts` `setupNode`)
Replace the "skip if veREPPO>0" branch: read current veREPPO (existing
`queryBalanceJson().veReppo`), call `planStakeTopUp`; if non-null, `executor.lock(...)`
and log `topping up veREPPO <current> → <target> (+<diff>, <days>d)`; if null, log the
current state and skip. A lock error logs a warning and setup continues (the node still
runs on existing veREPPO — never crash on lock). Seed the shared
`lastAttemptedStakeTarget` (see §4) with the target it acted on.

### 4. Per-cycle (`src/runtime/cycle.ts` + `wiring.ts`)
A new step at the TOP of `runCycle` (before the datanet loop): `maybeTopUpStake`.
- Reads live current veREPPO via a `deps.getVeReppo(): Promise<number>` reader (wired in
  `buildCycleDeps`; reuses the same balance query the snapshot uses) and the live
  hot-reloaded `config.stake`.
- Computes `plan = planStakeTopUp(current, config.stake)`.
- Guard: attempt only if `plan` is non-null AND `config.stake.lockReppo !==
  lastAttemptedStakeTarget`. On any attempt, set `lastAttemptedStakeTarget =
  config.stake.lockReppo` (module/closure state, per-process).
  - Success → veREPPO reaches target → `planStakeTopUp` returns null next cycle anyway.
  - Failure → the `!==` guard blocks re-attempts until the operator changes the target
    (or restarts) — no per-cycle lock spam.
- Wrapped in try/catch: a failure is logged + recorded (reuse the activity skip/record
  path with a clear reason) and the cycle proceeds. Never throws.
- On success, record an activity breadcrumb (e.g. `kind:'stake'` or a clear reason on an
  existing kind) so the dashboard shows the top-up.

`lastAttemptedStakeTarget` is shared between the startup seed (§3) and the per-cycle
guard so a boot-time attempt isn't immediately repeated on cycle 1.

### 5. Reading current veREPPO
`getVeReppo` uses the existing `queryBalanceJson()` (`src/reppo/queryBalance.ts`,
`veReppo` field) — the same source the snapshot + `setupNode` already use. No new query.

## Safety
- Consent-bounded: the lock amount derives from the operator's `config.stake.lockReppo`;
  no new budget cap (consistent with today's lock). The startup/cycle log makes each
  top-up visible.
- Down-bump (target < current): `planStakeTopUp` → null (can't unlock early). No-op.
- Insufficient REPPO: CLI fails closed → `executor.lock` returns an error → logged,
  guarded against retry, cycle proceeds.
- Idempotency by target → no double-lock on crash-retry.

## Testing
- `planStakeTopUp`: target>current → diff + correct durationSeconds; current≥target →
  null; target≤0 → null; current 0 → full target. (table-driven, pure)
- `maybeTopUpStake` (cycle): target>current + fresh target → calls `executor.lock` with
  the diff + target idempotency key; same target already attempted → no second lock;
  lock throws → cycle continues + records a skip (does not abort); current≥target → no
  lock.
- Startup: `setupNode` tops up when below target; skips at/above; lock error → warn +
  continue (no throw).
- Regression: existing first-lock-from-zero behavior preserved (current 0 → locks the
  full target).

## Out of scope
- Extending an existing lock's **duration** (VeReppo not enumerable; lockup id
  unrecoverable).
- Capturing/persisting lockup ids.
- Any reppo-cli or VeReppo contract change.
- A per-datanet or per-action stake budget cap (consent stays the config value).
