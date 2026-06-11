# Multi-agent vote/mint decisions ("the panel")

Date: 2026-06-11
Status: approved

## Problem

Every vote and mint decision today is one LLM call (`createLlmScorer` for votes,
`CandidateScorer` for mints): one prompt, one 1-10 score, one threshold cut. A
single sample is noisy exactly where it matters most — pods near the like/dislike
cutoffs, and mints, where a wrong yes burns 150-200 REPPO. The node should be
*agentic*: multiple agents with opposing stances deliberating one decision.

## Decision summary

- **Scope**: both votes and mints.
- **Mechanism**: persona panel + judge (one deliberation round, no multi-round debate).
- **Panel**: bull, bear, rubric-purist (hardcoded v1).
- **Cost control**: tiered — cheap single screen first; panel only for ambiguous
  votes and all mints.
- **Observability**: full transcript in the activity log and dashboard.
- **Architecture**: decorator scorers behind the existing `PodScorer` /
  `CandidateScorer` interfaces (approach A); selection logic untouched.

## Architecture

New module `src/panel/`:

| file | responsibility |
|---|---|
| `personas.ts` | pure: persona definitions + per-persona prompt builders |
| `judge.ts` | pure: judge prompt builder + verdict schema |
| `deliberate.ts` | `runPanel(model, input)`: 3 persona calls in parallel → 1 judge call → `PanelResult` |
| `scorers.ts` | `createPanelPodScorer` / `createPanelCandidateScorer` — decorators implementing the existing scorer interfaces |

`src/runtime/wiring.ts` injects the panel scorers instead of the single-call
scorers. `selectVotes` / `selectMints` stay as they are except for threading the
optional `panel` transcript into intents.

### Decision flow

```
pod/candidate
  → screen: today's single scorer call (votes only; mints skip straight to panel)
  → tier gate:
      vote: screen score within ±voteBand of that datanet's like OR dislike threshold → panel
      mint: always panel
      else: screen result stands (1 call, unchanged from today)
  → panel: bull / bear / purist score+argue in parallel (3 calls)
  → judge: rubric + operator brief + 3 arguments → final {score, reason} (1 call)
  → PodScore { score, reason, panel?: PanelTranscript }
```

### Threshold context

`PodScorer.scorePod` gains an optional third argument `{ like, dislike }`.
`selectVotes` already holds the strictness thresholds and passes them through.
Existing scorer implementations remain valid (the argument is optional).

## Panel mechanics

**Personas** — each receives the same rubric + pod/candidate text as today plus a stance:

- **bull**: argue the strongest honest case FOR the pod earning rewards; surface
  quality signals the rubric values.
- **bear**: argue the strongest honest case AGAINST; surface rubric violations,
  thin data, spam patterns.
- **purist**: ignore upside/downside; score strictly literal rubric compliance
  (neutral anchor).

Each returns `{ score: 1-10, argument: ≤400 chars }` via `generateObject`
(`mode: 'tool'`, retry-once — same pattern as `createLlmScorer`). All personas
keep the prompt-injection guard: pod text is untrusted; embedded instructions are
ignored.

**Judge** — receives rubric + operator strategy brief + three
`{persona, score, argument}` tuples. Returns `{ score: 1-10, reason: ≤600 }`.
Instructions: weigh arguments on rubric merit, not persona majority; the purist
score anchors — a final score deviating more than 2 from the purist must justify
the deviation in the reason. The judge's score is THE score; strictness
thresholds apply to it exactly as they do today. The judge sees the operator
brief (personas do not) so panelists argue evidence and the judge applies the
operator's stance.

**Tier band** — vote panels trigger when
`screen ∈ [dislike−voteBand, dislike+voteBand] ∪ [like−voteBand, like+voteBand]`.
Mints never screen: the panel replaces the single call (4 calls total, was 1).

**Cost envelope** — clear-cut vote: 1 call (today's cost). Ambiguous vote: 5
calls. Mint: 4 calls. Per-cycle volume already bounded by `voteRateMaxPerCycle`
and adapter `topN`.

## Types & observability

```ts
interface PanelTranscript {
  screenScore?: number   // absent for mints (no screen call)
  panelists: { persona: string; score: number; argument: string }[]
  judge: { score: number; reason: string }
}
```

- `PodScore` gains optional `panel?: PanelTranscript`.
- `VoteIntent` / `MintIntent` carry it; the executor writes it onto the activity
  log entry (`panel` field). ~600 bytes per panel decision; acceptable at current
  volume (issue #28 tracks the SQLite migration if the log outgrows JSONL).
- Dashboard: activity rows with `panel` show a "⚖ 3-agent" badge; expanding the
  row reveals persona scores/arguments and the judge reason. Cycle-health table
  unchanged.
- Mid-range panel outcomes produce no intent — identical skip semantics to today.

## Config

New optional strategy-config block (schema-defaulted; existing configs load unchanged):

```jsonc
"deliberation": {
  "enabled": true,   // default true
  "voteBand": 1      // ± band around thresholds that convenes a vote panel; 0 = mints only
}
```

`enabled: false` short-circuits the decorators to the wrapped single scorers —
exactly today's behavior, one call per decision, no transcripts.

Surfaced in the dashboard settings grid (two fields). Known to the strategy-chat
and onboarding assistants through the schema. No per-datanet override in v1.

## Error handling

- Persona call fails (after its retry): proceed with the surviving panelists
  (≥2); the judge is told which voice is missing.
- All personas fail, or the judge fails: fall back to the screen result for
  votes; for mints, skip the candidate with the same per-candidate error logging
  the single scorer uses today.
- Invariant: the panel must never make the node more fragile than the
  single-scorer path.

## Testing

- Prompt builders: pure unit tests (stance present, injection guard present,
  rubric/brief placement).
- `runPanel`: `MockLanguageModelV1` tests — happy path, one persona fails, judge
  fails, all-fail fallback.
- Decorators: tier-gate math per strictness level; mints always panel;
  `enabled:false` short-circuits to the wrapped single scorer.
- Selection regression: `selectVotes` / `selectMints` with a stub panel scorer
  (transcript threads through to intents).
- Schema: `deliberation` defaults applied to legacy configs.

## Out of scope (v1)

- Operator-defined personas / per-datanet panels (layer on later; the decorator
  seam doesn't change).
- Multi-round rebuttal debate.
- Panel for claim/grant/lock decisions (no judgment involved).
