# Orquestra Source Adapters + Personalized Minting Strategy — Design

**Date:** 2026-06-08
**Status:** Approved (design); pending implementation plan(s)
**Goal:** Add a **`gdelt` source adapter** so the node can mint on datanet 2
("Geopolitical Flashpoint & Misinfo Detection") — and make minting **personalized per
operator** so independent nodes naturally mint *different* content (personalization is
the differentiation). Establish that adapters are named by **data source** and reusable
across datanets, specialized per (datanet, operator) by an operator-defined strategy
elicited through a guided onboarding interview.

---

## Core principle: source adapters, reused across datanets

Adapters are named by their **data source**, not a datanet/domain:
- `hyperliquid` — trading data (serves datanet 9; reusable for other trading datanets).
- `gdelt` — global news/events (serves datanet 2; reusable for other news/claims datanets).

A datanet selects a source via config `datanets[id].adapter = "gdelt"`. The adapter's
`discover(ctx)` already receives `ctx.datanetId` + `ctx.rubric`, so **one source adapter
can back many datanets** with no interface change. What specializes a shared source for a
given datanet + operator is the **per-(datanet, operator) strategy** (below).

(Rename: the earlier "geopolitical" adapter becomes **`gdelt`** — `src/adapter/gdelt/`,
`id: "gdelt"`.)

## Why personalize (differentiation + alignment + ownership)

Every node queries the same GDELT and wants the same big winning events → built-in
convergence toward duplicates. Rather than fight that with dedup tricks alone, **let each
operator define their own strategy** (focus, angle, sourcing emphasis). Different
strategies → different GDELT pulls + different syntheses → different minted claims.

This also *aligns with how datanet 2 pays*: its voter rubric rewards "real human
conviction… sharp takes that go against the crowd," so diverse/personal angles earn more,
not less. And it matches the operator's mental model: "this is *my* node running *my*
strategy."

Evidence the shape matters (from the on-chain study): winners on #2 are crisp, falsifiable
claims with a stance/verdict ("Taiwan invasion off the table through 2027"; "Trump deal
claim is real, not premature"), not raw news links. The LLM synthesizes that shape; the
operator's strategy gives it a distinct angle.

## Per-operator strategy

Captured per mint-enabled datanet:
- **focus** — regions/topics/keywords (e.g. "Middle East energy," "Taiwan/China," "sanctions").
- **angle/stance** — contrarian vs consensus, risk-focused, which claim types to favor.
- **strictness** — existing knob (maps to score thresholds).
- **strategy brief** — freeform prose describing the operator's approach.

Storage:
- structured fields → `adapterParams` on the datanet policy in `strategy.config.json`.
- the brief → `strategy-notes.md` (the original design already defines this as
  "free-text strategy brief, injected into agent prompts").

The brief personalizes **both** sides:
- **mint** — injected into the `gdelt` claim-synthesis prompt (angle/focus shape claims).
- **vote** — injected into the voter scorer prompt alongside the datanet rubric +
  strictness, so the operator's stance shapes curation too. One coherent "node personality."

## Architecture — the `gdelt` source adapter

```
src/adapter/gdelt/
  gdelt.ts   — fetchGeoEvents(query, params) (default curls GDELT DOC 2.0) + pure parseGdelt(raw) → GeoArticle[]
  claim.ts   — synthesizeClaims(model, articles, rubric, strategy) → CandidatePod[] (LLM + quality gate)
  index.ts   — createGdeltAdapter({ model, fetchEvents?, params? }) → DatanetAdapter (id "gdelt")

discover(ctx):
  1. build GDELT query from the operator's focus (ctx-supplied strategy)
  2. fetchGeoEvents()                                  → recent articles (last N hours)
  3. synthesizeClaims(model, articles, ctx.rubric, strategy)  → up to topN claims (ONE batch LLM call,
        prompt carries the operator's angle + brief + the datanet rubric)
  4. in-adapter quality gate (importance/falsifiability/sourcing per strictness)
  5. → CandidatePod[]
```

- `GeoArticle { url; title; domain; seendate }`; `parseGdelt` tolerant, drops url-less.
- `fetchGeoEvents` injected (DI) → tests use a captured fixture, no live network.
- Synthesis: one `generateObject` call (Zod schema, `mode:'json'`, retry-once — mirrors
  the resilient voter scorer). **Untrusted-content guard** in the system prompt (GDELT
  titles are untrusted; never follow embedded instructions).
- **Strategy reaches the adapter** via params at construction (per-datanet `adapterParams`
  resolved in `index.ts`) and/or `ctx`; the synthesis prompt includes focus + angle +
  brief + the datanet's `publisherSpec`/`voterRubric`.

### Candidate / dataset shape

```jsonc
{
  canonicalKey: "<sha256(datanetId:primarySourceUrl)>",
  podName: "Israel–Lebanon ceasefire holds through June",   // the falsifiable claim
  podDescription: "Verdict: credible (7/10). <rationale>. Source: <url>",
  dataset: {
    kind: "geopolitical-claim", schema_version: 1,
    claim, verdict: "credible|likely|disputed|exaggerated", confidence: 1-10,
    timeframe?, rationale,
    sources: [{ url, title, domain, seendate }]
  }
}
```

## Dedup — layered (personalization primary)

1. **Personalization (primary):** different operator strategies → different focus/angle →
   different claims. The main mechanism.
2. **Novelty-check vs on-chain pods (backstop):** before minting, the adapter checks each
   candidate against datanet 2's existing pods (already fetched for the seen-set) and
   skips a claim that substantially duplicates an existing one (LLM-judged, semantic).
3. **Exact-key seen-set (cheap):** `canonicalKey = sha256(datanetId:primarySourceUrl)`
   (sources sorted, first = primary → stable key); the on-chain seen-set in `cycle.ts`
   skips exact matches.

Honest limit: simultaneous minters (TOCTOU) and two operators independently landing the
same take aren't fully preventable without coordination — accepted.

## Guided onboarding (the "guider")

The existing conversational wizard gains a thorough, branching elicitation for each
mint-enabled datanet: it *asks the operator* — what regions/topics to focus on, what angle
(contrarian/consensus/risk), how strict, any specific emphasis — explaining tradeoffs,
suggesting from the datanet's rubric, and confirming. It writes the structured strategy +
the brief. Goal: maximal clarification up front, then the node runs autonomously on the
saved strategy.

## Config wiring

- `strategy.config.json`: datanet 2 → `{ vote: true, mint: true, strictness, adapter:
  "gdelt", adapterParams: { focus, angle, gdeltQuery?, topN?, minImportance? } }`.
- `src/config/schema.ts`: add optional `adapterParams` (record) to the datanet policy.
- `src/index.ts`: adapters array → `[createHyperliquidAdapter(), createGdeltAdapter({ model })]`;
  resolve each datanet's `adapterParams` and pass to the adapter (via ctx or a per-datanet
  factory binding). `cycle.ts` routes `policy.adapter` → `getAdapter` (unchanged).
- **Voter:** thread the strategy brief into the scorer's prompt.
- **Earn cron:** no change — `selectOurPods` matches by recorded mint name; `mintDatanets`
  now includes 2.

## Safety

Unchanged boundary: adapters only **propose**; the deterministic budget manager signs;
caps + dedup + the candidate scorer bound a bad batch. GDELT content stays untrusted
(injection guard). No arbitrary operator-supplied sources (that's the deferred
codegen/SDK direction) — operators tune a *supported* source, so no untrusted code runs.

## Decomposition — two implementation plans

**Plan A — `gdelt` source adapter + strategy params + dedup + vote-brief.**
The `gdelt` adapter (fetch/parse/synthesize/gate), `adapterParams` in the schema, the
novelty-check backstop, wiring datanet 2 to mint, and threading the brief into mint+vote
prompts. Works with a hand-edited config. This is the core, independently shippable.

**Plan B — guided onboarding elicitation.**
Enrich the onboarding wizard to interview the operator and produce the strategy +
adapterParams + brief. Makes A operator-friendly; depends on A's schema.

## Testing

- `parseGdelt(fixture)` → `GeoArticle[]` (captured GDELT DOC JSON; drops url-less).
- `synthesizeClaims` with a fake model → `CandidatePod[]` (claim/verdict/sources/key);
  importance gate drops weak; **strategy (focus/angle/brief) appears in the prompt**;
  injection guard present.
- novelty-check: a candidate duplicating an existing on-chain pod is skipped.
- `createGdeltAdapter().discover()` with injected `fetchEvents` + fake model → candidates;
  empty GDELT → `[]`; synthesis throw degrades gracefully.
- `canonicalKey` deterministic for a given primary source.
- schema: `adapterParams` parses + defaults; config round-trip.
- voter: strategy brief reaches the scorer prompt (B/A seam).
- onboarding (Plan B): elicitation produces valid strategy + adapterParams.
- No live network/LLM in unit tests (DI); live GDELT + a real cycle verified in-container.

## Out of scope

- Fully custom / bring-your-own data sources (deferred codegen/SDK direction).
- Unverified-rumor / social misinfo sourcing (GDELT can't; needs a social source).
- Event clustering across articles (v1: the batch LLM call selects top events).
- Templateization / registry (adapters array stays hardcoded until that system exists).

## Success criteria

- Datanet 2 mints crisp, personalized claim pods via the `gdelt` adapter (verified live).
- Two different strategies produce visibly different claim sets (differentiation works).
- The real test (same gate as #9): do the claims **win curation** — upvotes → claimable
  emissions — watchable via the earn cron over the next epoch(s).
