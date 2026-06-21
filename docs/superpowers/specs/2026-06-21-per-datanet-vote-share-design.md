# Per-datanet vote share (weighted round-robin)

**Date:** 2026-06-21
**Status:** Design — pending implementation
**Topic:** Let an operator dedicate a share of each cycle's finite voting capacity to each datanet.

## Problem

Voting power is a finite, per-epoch pool (veREPPO-backed): every vote runs
`reppo vote --votes <conviction>`, spending `conviction` units. The node also caps
**votes cast per cycle** at `budget.voteRateMaxPerCycle` (global, monotonic,
enforced by `BudgetLedger.canVote()`).

Today the cycle iterates datanets **sequentially** (`cycle.ts`): the first datanet
scores and votes until the shared budget is spent, so a busy datanet (e.g. EXYLOS /
datanet 21 with 50+ episodes) drains the cycle's vote slots before datanets 2/4/5/9/11
get a turn. There is no way to say "dedicate 40% of my voting to datanet 21."

## Goal

An operator assigns a **relative weight** per datanet. Each cycle's vote slots (and,
implicitly, the voting power spent) are distributed across vote-enabled datanets in
proportion to their weights. A datanet that runs out of eligible pods mid-cycle yields
its remaining turns to datanets that still have pods (no wasted slots).

Out of scope (deliberately): explicit per-epoch power-unit accounting. Power (~3185) is
abundant; splitting the per-cycle vote count bounds power spend implicitly. Splitting
mint budget per datanet is also out of scope.

## Chosen approach — weighted scheduler over pod scoring (Approach 3)

The naive round-robin trap: scoring is the expensive step (LLM call; for video pods a
Gemini Files-API upload). Scoring **all** pods across **all** datanets and then executing
only `voteRateMaxPerCycle` of them would burn LLM/Gemini spend on hundreds of pods that
never get a slot — violating the existing pre-scoring budget gate (`cycle.ts:278`).

Therefore the scheduler interleaves at the **scoring level**: it services one pod at a
time, choosing the next *datanet* by weight, and only while the global vote budget
remains. Scoring and votes are both spread across datanets by weight; no wasted slots and
no wasted scoring.

### Component: `weightedSchedule` (new, pure)

`src/voter/schedule.ts` — a pure weighted-fair-queuing (WFQ) chooser, unit-tested in
isolation.

- Input: a set of datanet entries `{ datanetId, weight, remaining: () => boolean }`.
- Each datanet has a **virtual time** `vt_i`, initialized to 0.
- `next()` returns the datanet with the smallest `vt_i` among those whose `remaining()`
  is true (i.e. still has queued pods). On selection it advances `vt_i += 1 / weight_i`.
- A datanet whose queue drains simply stops being `remaining()` and leaves the candidate
  set — its turns automatically flow to the others (the redistribution the operator asked
  for). No explicit rebalancing code.
- Returns `null` when no datanet is `remaining()`.

WFQ gives proportional fairness (a weight-3 datanet is serviced ~3× as often as a
weight-1 one) and free redistribution. The function is deterministic and pure (ties broken
by datanet id order), so it tests without any cycle/LLM machinery.

### Integration into the cycle

The cycle splits into phases (today they are interleaved in one loop):

1. **Setup pass (per datanet, sequential)** — unchanged: stake top-up, capability check,
   subnet-access grant. Same code, same per-datanet error isolation.
2. **Vote pass (cross-datanet, NEW scheduler)** — replaces the per-datanet vote block at
   `cycle.ts:272–~330`.
3. **Mint pass (per datanet, sequential)** — unchanged.

Vote pass detail:

- For each vote-enabled datanet with a rubric (`policy.vote && rubric.canVote`), call
  `getPodsAndFilter(datanetId)` once to build a **queue** of eligible pods, ordered
  **newest-epoch-first**. A `getPodsAndFilter` throw isolates that datanet (recorded skip,
  excluded from the schedule) — preserving today's behavior. A datanet whose scorer
  fails to resolve (`voteScorerFor` returns `{skip}`) is likewise excluded with a recorded
  skip.
- Build `weightedSchedule` entries from the surviving datanets (`weight = policy.voteShare`,
  `remaining = queue not empty`).
- Loop while `deps.ledger.canVote()` (global vote budget/gas remains):
  - `dn = schedule.next()`; if `null`, stop (all queues drained).
  - Dequeue the next pod from `dn`'s queue. Score it (`scorePod`, which honors the global
    `videoPodsPerCycle` cap — an over-cap video is skipped, not scored, but still consumes
    the turn). Per-pod scoring skips record a `skip` activity row, exactly as today.
  - If scoring yields a vote intent, `executeVote` it. Record dedup only on `executed`
    (and the `CANNOT_VOTE_FOR_OWN_POD` permanent case), identical to current logic. A
    `refused-budget` result means the global cap was hit between the `canVote()` check and
    the sign — stop the loop.
- When the loop ends with pods still queued, record a single per-datanet deferral
  breadcrumb (those pods retry next cycle), mirroring the current single-deferral-note
  behavior rather than one refused row per pod.

Per-pod error isolation: a thrown scoring/execute error for one pod records an activity row
and continues the scheduler (the datanet stays in rotation unless its queue is now empty).
A failure never aborts the cycle.

The `BudgetLedger` is **unchanged** — the global per-cycle cap stays the security backstop;
weights only decide *order*, never raise the cap.

## Config

Add to `DatanetPolicy` (`src/config/schema.ts`):

```ts
// Relative weight for this datanet in the per-cycle vote scheduler. Higher = more of the
// cycle's finite vote slots/power. Normalized across vote-enabled datanets; absolute value
// is irrelevant (3 vs 1 == 75%/25%). Default 1 = equal share.
voteShare: z.number().positive().default(1),
```

Default 1 ⇒ equal split across vote-enabled datanets. This changes today's first-come
behavior to fair-share even when no weight is set — an intentional improvement. Hot-reloaded
each cycle like the rest of the config.

## Dashboard

Add a per-datanet **"Vote share"** numeric input in the strategy/config UI (next to the
existing per-datanet controls), with a hover tooltip consistent with the existing tooltip
set: *"Relative weight for splitting this cycle's vote slots across datanets. 3 vs 1 means
this datanet gets 3× the votes of a weight-1 one. Default 1 (equal share)."* No new API
shape — it rides the existing config read/write path.

## Testing

- `schedule.test.ts` (pure): proportional service counts for given weights; redistribution
  when a queue drains early; deterministic tie-break; `null` when all drained; single
  datanet; zero candidates.
- Cycle wiring tests (extend `cycle.test.ts` / `wiring.test.ts`): two datanets with weights
  3:1 and ample pods ⇒ ~3:1 executed votes capped at `voteRateMaxPerCycle`; a datanet that
  runs dry yields turns to the other; the `videoPodsPerCycle` cap still bounds video
  scoring within the schedule; a `getPodsAndFilter` throw isolates one datanet; the global
  ledger cap still stops the loop.
- `schema.test.ts`: `voteShare` defaults to 1; rejects non-positive.

## Risk

This rewrites the vote phase of `cycle.ts` — the node's most central, most-tested code.
Mitigations: the scheduling logic is extracted as a pure function; the ledger (the security
boundary) is untouched; per-pod isolation and dedup semantics are preserved verbatim; the
mint and setup phases are unchanged.
