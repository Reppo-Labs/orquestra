# Per-datanet vote share (in-loop slot caps)

**Date:** 2026-06-21
**Status:** Design — pending implementation
**Topic:** Let an operator dedicate a share of each cycle's finite vote capacity to each datanet.

## Problem

Voting power is a finite, per-epoch pool (veREPPO-backed): every vote runs
`reppo vote --votes <conviction>`, spending `conviction` units. The node also caps
**votes cast per cycle** at `budget.voteRateMaxPerCycle` (global, monotonic, enforced by
`BudgetLedger.canVote()`).

Today the cycle iterates datanets **sequentially** (`cycle.ts`). The first datanet scores
and votes until the shared per-cycle budget is spent, so a busy datanet (EXYLOS / datanet
21, 50+ episodes) drains the cycle's vote slots before datanets 2/4/5/9/11 get a turn.
There is no way to say "dedicate 40% of my voting to datanet 21."

## Goal

An operator assigns a **relative weight** per datanet. Each cycle's vote slots are
distributed across vote-enabled datanets in proportion to their weights, so no datanet can
starve the others. A datanet that doesn't use its full share yields the leftover to
datanets that still have pods (redistribution).

Out of scope (deliberately): per-epoch power-unit accounting (power ~3185 is abundant;
splitting the per-cycle vote count bounds power spend implicitly); per-datanet mint budget;
per-datanet **video** slot allocation (the `videoPodsPerCycle` cap stays global — see
Non-goals).

## Approach — in-loop execution caps + a redistribution pass (Approach 1)

This was chosen over a cross-datanet round-robin scheduler (Approach 3) after an adversarial
design review: Approach 3 required splitting the single per-datanet cycle loop into
setup/vote/mint passes, which breaks the grant→mint gate, the health "idle" signal, and the
shared `videoBudget`'s consumption model, and its WFQ scheduler split *scoring count* rather
than *votes cast*. Approach 1 keeps the existing single loop and changes only **how many
votes each datanet may execute**, so none of those hazards arise.

### Key facts this design relies on (verified against the code)

- `selectVotes` (`src/voter/select.ts`) already does eligibility filtering internally
  (current-epoch, not-own, not-already-voted, lines 27–32) and scores **all** eligible pods,
  returning vote intents. We do **not** rebuild a "queue" or move eligibility out — it stays.
- The expensive scoring path (video → Gemini Files-API upload) is already bounded **per
  cycle** by the shared `videoBudget` (default 4), decremented in `getPodsAndFilter`
  enrichment (`wiring.ts`): a video over the cap is skipped, never scored. So total scoring
  cost is **not** a function of vote slots, and capping execution (not scoring) introduces no
  scoring-cost regression versus today.
- The per-cycle vote cap lives in `BudgetLedger.canVote()` and is **left untouched** — the
  security boundary is unchanged; weights only decide *distribution within* that cap.

### Component: `allocateVoteSlots` (new, pure)

`src/voter/allocate.ts` — `allocateVoteSlots(weights: Map<string, number>, total: number):
Map<string, number>`.

- Largest-remainder (Hamilton) apportionment: `ideal_i = total · w_i / Σw`; floor each;
  distribute the remaining `total − Σfloor` slots to the largest fractional remainders, ties
  broken by datanet id (deterministic).
- Σ of returned slots == `total` (when `total ≤ Σ pods` is not assumed — it just splits the
  count). `total = 0` → all zero. Single datanet → all `total`. Empty weights → empty map.
- Pure and deterministic → unit-tested with zero cycle/LLM machinery.

### Cycle integration (single loop preserved)

1. **Before the loop** — compute the slot map. Weight set = config datanets with
   `policy.vote === true`, **excluding the injected `'*'` wildcard key** (`schema.ts`
   transform adds it; it is not a real datanet). `weight = policy.voteShare`.
   `slots = allocateVoteSlots(weights, voteRateMaxPerCycle)`.

2. **Pass 1 — inside the existing per-datanet loop, unchanged structure.** Setup, grant
   (with its `continue`-gating), and mint stay exactly as today. The only change is the vote
   block: after `selectVotes` returns `intents`, execute at most `slots[datanetId]` of them
   (in `selectVotes` order — NOT sorted by conviction: conviction is the raw 1–10 score, so a
   desc sort would systematically keep strong upvotes and drop strong downvotes, an unwanted
   bias). The remaining intents are **stashed** as `leftover[datanetId]` (already scored — no
   re-scoring later). Casting also stops on the first `refused-budget` (monotonic). Dedup-on-
   executed, `CANNOT_VOTE_FOR_OWN_POD`, stale-grant eviction, and the per-pod scoring-skip
   activity rows are all **unchanged** (factored into a shared `castVote` helper).

3. **Pass 2 — redistribution, after the loop.** `remaining = voteRateMaxPerCycle − executed
   so far`. Compute a second split with `allocateVoteSlots(weights restricted to datanets
   that still have stashed leftover, remaining)`, then execute that many leftover intents per
   datanet (in stash order), bounded by `ledger.canVote()`. If a datanet's leftover
   is smaller than its second-pass allotment, the surplus is re-split among the rest in the
   same way (iterate until `remaining` is spent or all stashes empty). Stop on the global cap.

4. **Deferral breadcrumb.** After Pass 2, any datanet with still-unexecuted leftover gets a
   single deferral note ("N votes deferred to next cycle"), mirroring today's single-note
   behavior. Pods retry next cycle (dedup recorded only on executed).

`getPodsAndFilter` is still called once per datanet **inside** the loop at that datanet's
turn — the existing pre-scoring gate (`cycle.ts:278`, skip scoring when `!canVote()`) stays,
so no enrichment is front-loaded for datanets the budget can't reach.

## Config

Add to `DatanetPolicy` (`src/config/schema.ts`):

```ts
// Relative weight for splitting this cycle's vote slots across vote-enabled datanets.
// Normalized; absolute value is irrelevant (3 vs 1 == 75%/25%). Default 1 = equal share.
voteShare: z.number().positive().finite().default(1),
```

`.finite()` rejects `Infinity`/`NaN` (which would collapse the apportionment). Default 1 ⇒
**equal split** across vote-enabled datanets — chosen deliberately: it fixes the starvation
in the box. **This changes today's first-come behavior** even for operators who never set a
weight; called out here and in the dashboard tooltip. Hot-reloaded each cycle like the rest
of config. Existing persisted configs (DB `config` row) lack the field → the Zod default
applies on load, no migration needed.

## Dashboard

Per-datanet **"Vote share"** numeric input in the strategy/config UI, hover tooltip:
*"Relative weight for splitting this cycle's vote slots across datanets. 3 vs 1 means this
datanet gets 3× the votes of a weight-1 one. Default 1 = equal share. (Changes how the
per-cycle vote cap is divided; does not raise it.)"* Rides the existing config read/write
path — no new API shape.

## Non-goals / known limitations (explicit)

- **Video slots remain global.** `videoPodsPerCycle` (4) is consumed in datanet-iteration
  order during enrichment, not by `voteShare`. With EXYLOS the only video datanet today this
  is fine; a future "per-datanet video share" is a separate feature. The spec does NOT claim
  weighted video scoring.
- **Scoring volume is unchanged from today** (selectVotes still scores all eligible pods;
  video bounded by `videoBudget`). Capping scoring at the slot count is a possible future
  optimization, not in scope.

## Testing

- `allocate.test.ts` (pure): exact slot sums for given weights/total; largest-remainder
  rounding; deterministic id tie-break; `total=0`; single datanet; empty weights; one
  datanet weight ≫ others.
- `schema.test.ts`: `voteShare` defaults to 1; rejects 0, negatives, `Infinity`, `NaN`.
- Cycle tests (`cycle.test.ts`): with a **stubbed scorer** (deterministic, no panel/LLM) —
  (a) two datanets 3:1, both with ample pods ⇒ executed votes 3:1 and Σ == cap; (b) a datanet
  using fewer than its share leaves slots that Pass 2 redistributes to a busy datanet;
  (c) the `'*'` wildcard never receives slots; (d) grant-failure still skips BOTH vote and
  mint (regression guard for the preserved loop); (e) global ledger cap still bounds total
  executed; (f) deferral note emitted once when leftovers remain after Pass 2.

## Risk

Low relative to Approach 3: the single per-datanet loop, `selectVotes`, `BudgetLedger`, the
grant gate, the health-idle signal, dedup, and per-pod isolation are all unchanged. New code
is the pure `allocateVoteSlots`, an execution-count cap + stash in the vote block, and a
post-loop redistribution pass. The main behavior change is intentional: default equal-split.
