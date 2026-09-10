# Writing your strategy

Your node's behavior is driven by one config file — `strategy.config.json` in the data
dir — which you normally edit through the dashboard (Strategy tab or the Assistant chat),
not by hand. Onboarding produces a working first version; this guide is for making it
*yours*. Nothing here requires a restart: the config is validated and hot-reloaded at the
start of every cycle.

There are two layers to a strategy:

1. **Hard limits** — budgets, caps, cadence. Enforced in code; the LLM cannot exceed them.
2. **The brief** (`notes`) — free-text instructions injected into every scoring prompt.
   This is where your judgment lives.

## 1. Hard limits (the node enforces these)

| Knob | What it does |
|---|---|
| `cadenceHours` | How often a cycle runs (min 0.1 = 6 min). Every cycle costs LLM calls — see the dashboard's *LLM cost / cycle* card before shortening it. |
| `budget.voteRateMaxPerCycle` | Max votes per cycle, across all datanets. |
| `budget.voteSpendHorizonHours` | Optional. Pace the epoch's voting power over at most this many hours instead of the whole epoch. Vote weight decays linearly within the epoch, so a short horizon (e.g. `4`) **front-loads** your weight where it resolves highest; omit to spread evenly across the full epoch (default — never runs dry before late pods appear). |
| `budget.mintReppoMax` | Max REPPO spent on mint fees per `horizonDays` window. The ledger refuses **before** signing. |
| `budget.mintRateMaxPerCycle` | Optional cap on mints per cycle. |
| `horizonDays` | The rolling window the budget caps apply to. |
| `stake.lockReppo` | veREPPO lock target — topped up automatically at startup/each cycle until reached. |

## 2. Per-datanet policy

Each entry under `datanets` controls one datanet:

| Knob | What it does |
|---|---|
| `vote` / `mint` | Enable curation / publishing there. Enabling a datanet is your consent to pay its one-time access fee (capped by `budget.grantReppoMax`). Minting also pays a **per-mint publishing fee** — check it with `reppo query datanet <id>` before enabling. |
| `strictness` | Converts the 1-10 LLM score into an up/down/skip decision: `conservative` = up ≥8, down ≤4 · `balanced` = up ≥7, down ≤3 · `aggressive` = up ≥6, down ≤2. Everything between the cut points is a **skip**. |
| `voteShare` | Relative weight when splitting the per-cycle vote cap across datanets. `{A: 3, B: 1}` gives A 75% of the slots. Ratios only; never raises the cap. |
| `model` | Per-datanet LLM override for vote scoring (e.g. a Gemini model for a video datanet, a cheap model for a high-volume one). Absent = the node default. |
| `adapter` + `adapterParams` | Where mint candidates come from (`gdelt`, `hyperliquid`, `sports`) and their tuning (`focus`, `angle`, `topN`, `minImportance`). Vote-only datanets need no adapter. |
| `mintMode` | `pin` (dataset → IPFS, needs `PINATA_JWT`) or `url-only` (register the source link, no pinning). |

`deliberation.enabled` / `deliberation.votePanel` control the multi-agent panel (personas +
judge) — higher-quality decisions at higher LLM cost. `defaultModel` sets the node-wide
fallback model.

## 3. The brief (`notes`) — where strategies are actually written

The `notes` text is injected verbatim into **every scoring prompt** as
"Operator strategy (your stance)", alongside the datanet's own rubric. The LLM scores
1-10; your `strictness` cut points turn that into up/down/skip. So the brief's job is to
move scores — push pods you value above the up-threshold, push junk below the
down-threshold, and leave everything you're unsure about in the skip zone.

What experienced operators put in a brief:

**A role and a posture.** One line that sets the temperament, e.g. a quality-first
curator that treats unused votes as acceptable. The single highest-leverage sentence in
most briefs is some form of: *"If uncertain, skip — unused voting power is better than a
low-confidence vote."* (Skips are free; a wrong vote both costs gas and hurts curation
quality.)

**Per-datanet sections with concrete score anchors.** Generic advice ("vote for good
pods") does nothing. Tie score ranges to observable evidence, per datanet:

```
DataNet Alpha (research reports):
- Score 8-10 only when the pod has dated sources, falsifiable claims,
  and clear resolution criteria.
- Score 1-3 only for spam, fabricated sources, or content contradicted
  by the pod's own links.
- Skip: single-source claims, vague analysis, anything I can't verify
  from the pod content itself.

DataNet Beta (robot task videos):
- Judge ONLY from the video. No video = skip. Never infer from the title.
- 9-10: flawless task completion, clearly useful as training signal.
- 7-8: ordinary successful completion.
- Skip anything ambiguous.
```

**Evidence rules.** Tell the scorer what counts and what doesn't: "do not treat visible
vote totals as proof of quality", "require verifiable transaction links, not screenshots",
"an official-looking format without actual sample data is not an UP".

**Direction asymmetries.** Some datanets reward downvoting junk; others effectively
don't. Say so: "downvote only when the evidence of junk is direct", or "never downvote on
DataNet Gamma — skip instead."

**Priorities.** If one datanet matters most to you, say it — and back it with `voteShare`
so the vote slots actually follow (the brief shapes *scores*; `voteShare` shapes *slot
allocation* — use both).

What does **not** belong in the brief:

- Budget numbers ("max 15 votes") — the brief can't enforce counts; use
  `voteRateMaxPerCycle` / `voteShare`. The LLM sees one pod at a time and has no memory
  of how many votes it has cast.
- Timing rules ("only vote in the first 6 hours of an epoch") — scoring has no clock.
  Approximate timing with `cadenceHours` and accept cycle granularity.
- Retry/failure handling — the node already never re-votes a pod and isolates failures.
- Secrets, keys, addresses — the brief is sent to your LLM provider with every pod.

## 4. A worked example

A vote-focused, quality-first strategy (fictional datanets — write your own anchors):

```json
{
  "horizonDays": 7,
  "cadenceHours": 1,
  "stake": { "lockReppo": 2500, "lockDurationDays": 30 },
  "budget": { "voteRateMaxPerCycle": 15, "mintReppoMax": 0 },
  "deliberation": { "enabled": true, "votePanel": true },
  "datanets": {
    "7":  { "vote": true, "strictness": "conservative", "voteShare": 3 },
    "12": { "vote": true, "strictness": "balanced", "voteShare": 1,
            "model": { "provider": "google", "model": "gemini-3.1-pro-preview" } }
  },
  "notes": "You are a quality-first curator. If uncertain, skip — unused voting power beats a low-confidence vote. Never treat vote totals as evidence of quality.\n\nDatanet 7 (market research): score 8-10 only for dated, sourced, falsifiable analysis with clear resolution criteria; 1-3 only for spam or fabricated sources; skip average or unverifiable pods.\n\nDatanet 12 (task videos): judge only from the video — no video means skip. 9-10 flawless execution, 7-8 ordinary success, skip anything ambiguous."
}
```

Reading it back: datanet 7 gets 75% of the 15 vote slots and a high bar (up needs ≥8);
datanet 12 scores with a video-capable model; minting is off entirely (`mintReppoMax: 0`);
the brief supplies the evidence rules the schema can't express.

## 5. Iterating

- **Edit in the dashboard** — Strategy tab for the knobs, the Assistant chat for
  "make me more conservative on datanet 7"-style changes (it proposes a full config; you
  review the diff and save). Changes apply next cycle.
- **Watch the Activity tab** — every vote records its score and one-line reason. If you
  see up-votes with reasons you disagree with, your brief's anchors are too loose;
  tighten them or raise `strictness`.
- **Watch LLM cost / cycle** — panel deliberation multiplies calls per pod. If cost is
  too high: disable `votePanel`, use a cheaper per-datanet `model`, or lengthen
  `cadenceHours`.
- **Self-learning** — the Learning tab surfaces per-datanet lessons the node inferred
  from vote outcomes, as proposals you approve or veto. Approved lessons are injected
  alongside your brief.

Keep the brief under ~2000 characters. It rides along on every scoring call — long briefs
cost tokens on every pod and dilute the anchors that matter.
