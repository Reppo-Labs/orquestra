# Guided Onboarding Elicitation (Plan B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the personalized minting strategy operator-friendly: the existing conversational onboarding wizard *guides the operator* to define, per mint-enabled datanet, their `adapterParams` (focus / angle / strictness / topN) plus a freeform strategy brief — so no one hand-edits `strategy.config.json`.

**Architecture:** Extend `OnboardingAnswers`/`DatanetChoice` + the zod `OnboardingAnswersSchema` with optional `adapterParams`; have `buildStrategyConfig` write them into each datanet policy (Plan A's config schema already accepts `adapterParams`); and enrich the onboarding agent's system prompt so it thoroughly interviews the operator for mint datanets and finalizes with the structured params + brief. Conversational quality is LLM-driven (system prompt); the structured capture (schema, build, finalize) is unit-tested with no LLM.

**Tech Stack:** TypeScript (ESM/NodeNext), vitest, `zod`, the `ai` SDK (`MockLanguageModelV1` in tests). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-08-orquestra-source-adapters-personalized-strategy-design.md` (Plan B section)
**Depends on:** Plan A (merged) — `adapterParams` on the datanet policy in `src/config/schema.ts`; the `gdelt` adapter consuming `focus/angle/brief`.

---

## File structure

- Modify: `src/onboarding/types.ts` — `DatanetChoice` gains optional `adapterParams`; add an `AdapterParams` type.
- Modify: `src/onboarding/schema.ts` — `OnboardingAnswersSchema` datanet entry gains optional `adapterParams`.
- Modify: `src/onboarding/schema.test.ts`
- Modify: `src/onboarding/build.ts` — write `adapterParams` into the datanet policy.
- Modify: `src/onboarding/build.test.ts`
- Modify: `src/onboarding/agent.ts` — export + enrich the `SYSTEM` prompt to guide per-datanet strategy elicitation (focus/angle/strictness/topN) for mint datanets.
- Modify: `src/onboarding/agent.test.ts` — a finalize with `adapterParams` round-trips; the system prompt includes strategy-elicitation guidance.

> **Scope note:** the *structured* params we elicit are the generic, adapter-agnostic ones the `gdelt` adapter reads: `focus`, `angle`, `topN`, `minImportance`. The freeform **brief** continues to be the existing `notes` field (already written to `strategy-notes.md`, already injected into mint+vote by Plan A). We do NOT build a per-adapter param registry (YAGNI — gdelt is the adapter that needs rich params; HL has sensible defaults and ignores focus/angle).

---

### Task 1: Answers schema + types gain `adapterParams`

**Files:**
- Modify: `src/onboarding/types.ts`
- Modify: `src/onboarding/schema.ts`
- Modify: `src/onboarding/schema.test.ts`

- [ ] **Step 1: Append the failing test to `src/onboarding/schema.test.ts`**

```ts
describe('OnboardingAnswersSchema adapterParams', () => {
  const base = {
    datanets: [{ id: '2', vote: true, mint: true, strictness: 'balanced' as const, adapter: 'gdelt',
      adapterParams: { focus: 'Middle East', angle: 'contrarian', topN: 4, minImportance: 7 } }],
    lockReppo: 0, lockDurationDays: 30, voteGasEthMax: 0.02, voteRateMaxPerCycle: 25,
    mintReppoMax: 100, mintGasEthMax: 0.05, horizonDays: 30, cadenceHours: 6, notes: 'n',
  }
  it('accepts a datanet choice with adapterParams', () => {
    const parsed = OnboardingAnswersSchema.parse(base)
    expect(parsed.datanets[0].adapterParams?.focus).toBe('Middle East')
  })
  it('accepts a datanet choice WITHOUT adapterParams (optional)', () => {
    const { adapterParams, ...d } = base.datanets[0]
    expect(OnboardingAnswersSchema.parse({ ...base, datanets: [d] }).datanets[0].adapterParams).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run src/onboarding/schema.test.ts` → the extra `adapterParams` key is absent on the parsed result (first test fails: `.focus` undefined).

- [ ] **Step 3: Add `adapterParams` to the datanet entry in `src/onboarding/schema.ts`**

In `OnboardingAnswersSchema`, the `datanets` array element is currently
`z.object({ id, vote, mint, strictness, adapter: z.string().optional() })`. Add a sibling field:

```ts
      adapterParams: z.object({
        focus: z.string(),
        angle: z.string(),
        topN: z.number().int().positive(),
        minImportance: z.number().int().min(1).max(10),
      }).partial().optional(),
```

- [ ] **Step 4: Add the type in `src/onboarding/types.ts`**

Add an `AdapterParams` type:
```ts
export interface AdapterParams {
  focus?: string
  angle?: string
  topN?: number
  minImportance?: number
}
```
and in `DatanetChoice` add:
```ts
  adapterParams?: AdapterParams
```

- [ ] **Step 5: Run it, expect PASS.** `npx vitest run src/onboarding/schema.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/onboarding/types.ts src/onboarding/schema.ts src/onboarding/schema.test.ts
git commit -m "feat(onboarding): answers schema gains optional per-datanet adapterParams"
```

---

### Task 2: `buildStrategyConfig` writes `adapterParams`

**Files:**
- Modify: `src/onboarding/build.ts`
- Modify: `src/onboarding/build.test.ts`

- [ ] **Step 1: Append the failing test to `src/onboarding/build.test.ts`** (reuse the existing `answers()` helper)

```ts
describe('buildStrategyConfig adapterParams', () => {
  it('writes adapterParams onto the datanet policy when present', () => {
    const a = answers()
    a.datanets[0].adapter = 'gdelt'
    a.datanets[0].adapterParams = { focus: 'Taiwan', angle: 'risk', topN: 4, minImportance: 7 }
    const cfg = buildStrategyConfig(a)
    const p = cfg.datanets[a.datanets[0].id] as { adapterParams?: { focus?: string } }
    expect(p.adapterParams?.focus).toBe('Taiwan')
  })
  it('omits adapterParams when not provided', () => {
    const a = answers()
    const cfg = buildStrategyConfig(a)
    const p = cfg.datanets[a.datanets[1].id] as { adapterParams?: unknown }
    expect(p.adapterParams).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** — `buildStrategyConfig` doesn't carry `adapterParams` yet.

- [ ] **Step 3: Update `src/onboarding/build.ts`** — include `adapterParams` in the per-datanet policy

The loop currently builds:
`datanets[d.id] = { vote: d.vote, mint: d.mint, strictness: d.strictness, ...(d.adapter ? { adapter: d.adapter } : {}) }`.
Replace that assignment with:

```ts
    datanets[d.id] = {
      vote: d.vote, mint: d.mint, strictness: d.strictness,
      ...(d.adapter ? { adapter: d.adapter } : {}),
      ...(d.adapterParams ? { adapterParams: d.adapterParams } : {}),
    }
```

- [ ] **Step 4: Run it, expect PASS.** `npx vitest run src/onboarding/build.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/build.ts src/onboarding/build.test.ts
git commit -m "feat(onboarding): buildStrategyConfig writes per-datanet adapterParams"
```

---

### Task 3: Enrich the onboarding agent to elicit strategy

**Files:**
- Modify: `src/onboarding/agent.ts`
- Modify: `src/onboarding/agent.test.ts`

- [ ] **Step 1: Append the failing tests to `src/onboarding/agent.test.ts`**

```ts
import { SYSTEM } from './agent.js'

describe('onboarding strategy elicitation', () => {
  it('the system prompt guides eliciting per-datanet mint strategy (focus/angle)', () => {
    expect(SYSTEM.toLowerCase()).toContain('focus')
    expect(SYSTEM.toLowerCase()).toContain('angle')
    expect(SYSTEM.toLowerCase()).toContain('strategy')
  })

  it('finalize captures adapterParams and they survive validation', async () => {
    const captured: unknown[] = []
    const tools = buildOnboardingTools(deps(null as unknown as OnboardingAgentDeps['model']), (a) => captured.push(a))
    const ans = {
      ...validAnswers,
      datanets: [{ id: '2', vote: true, mint: true, strictness: 'balanced' as const, adapter: 'gdelt',
        adapterParams: { focus: 'Middle East', angle: 'contrarian', topN: 4, minImportance: 7 } }],
    }
    const res = await tools.finalize.execute(ans, { toolCallId: 'a', messages: [] } as never)
    expect(res).toMatchObject({ saved: true })
    expect((captured[0] as { datanets: { adapterParams?: { focus?: string } }[] }).datanets[0].adapterParams?.focus).toBe('Middle East')
  })
})
```

(`validAnswers`, `buildOnboardingTools`, `deps`, `OnboardingAgentDeps` are already defined/imported in `agent.test.ts`.)

- [ ] **Step 2: Run it, expect FAIL** — `SYSTEM` is not exported and lacks the guidance text.

- [ ] **Step 3: Export `SYSTEM` and enrich it in `src/onboarding/agent.ts`**

Change `const SYSTEM = ...` to `export const SYSTEM = ...` and replace the string with:

```ts
export const SYSTEM = `You are Orquestra's onboarding assistant. Help the operator configure a self-hosted Reppo agent node: which datanets to VOTE and/or MINT on, how much REPPO to lock (veREPPO voting power) and for how long, budget caps (vote gas, votes/cycle, mint REPPO, mint gas), the budget horizon, and how often the node runs (cadence hours).
Use list_datanets to answer "what's available" with live data. Use get_datanet_details to explain what a datanet wants and whether minting is possible.
IMPORTANT: minting requires a data adapter. Datanet 9 (TradingGym AI) uses "hyperliquid"; datanet 2 (Geopolitical) uses "gdelt". For datanets without an adapter, set mint=false (vote-only).
PERSONALIZED MINT STRATEGY — this is what makes each operator's node unique and avoids everyone minting the same data. For every datanet the operator chooses to MINT, GUIDE them to define a strategy by asking (one topic at a time, explaining tradeoffs, and suggesting options drawn from the datanet's rubric):
  - focus: which regions/topics/keywords to cover (e.g. "Middle East energy", "Taiwan/China", "sanctions").
  - angle: their stance — contrarian vs consensus, risk-focused, which kinds of claims to favor. (Datanet 2 rewards sharp, well-reasoned minority takes, so encourage a distinctive angle.)
  - how strict, and how many items per cycle (topN).
Pass these as that datanet's adapterParams { focus, angle, topN, minImportance } in finalize. Capture the operator's overall approach as freeform 'notes' (saved as the strategy brief, used for both minting and voting).
You may RECOMMEND choices from the catalog economics, but always confirm each decision with the operator before finishing. When the operator confirms, call finalize with the complete structured answers. Keep messages short.
Use get_wallet_balance to look up the operator's REPPO/veREPPO/ETH/USDC holdings when they express amounts relative to their balance (e.g. '80% of my REPPO').`
```

- [ ] **Step 4: Run it, expect PASS.** `npx vitest run src/onboarding/agent.test.ts`

- [ ] **Step 5: Full suite + typecheck.** `npx vitest run && npm run typecheck` → all green.

- [ ] **Step 6: Commit**

```bash
git add src/onboarding/agent.ts src/onboarding/agent.test.ts
git commit -m "feat(onboarding): guide per-datanet mint strategy elicitation (focus/angle/topN)"
```

---

### Task 4: Live onboarding walkthrough (manual, no commit)

**Files:** none.

- [ ] **Step 1: Run a real conversational onboarding in the container, mint-enabling datanet 2 — using a SCRATCH data dir so the live strategy isn't overwritten**

```bash
npm run build && docker build -q -t orquestra:redesign .
docker run -it --rm --env-file .env -v "$HOME/code/orquestra/orquestra-data-onboard-test:/data" orquestra:redesign configure
```

- [ ] **Step 2: Confirm** that when you choose to mint datanet 2, the assistant actively asks about focus + angle + strictness + topN (one at a time, with suggestions from the rubric), and that the resulting scratch `strategy.config.json` has `datanets["2"].adapterParams` with your focus/angle plus a `strategy-notes.md` brief. Note whether it genuinely *guides*. Delete the scratch dir afterward.

---

## Self-review checklist (completed)

- **Spec coverage (Plan B section):** guided per-datanet elicitation of focus/angle/strictness/topN → Task 3; structured params persisted → Tasks 1-2; brief = existing `notes` (already written + injected by Plan A) → unchanged, noted; "guide as much as possible, then run autonomously" → Task 3 system prompt. ✓
- **Placeholders:** none — full code in each step; the live walkthrough (Task 4) is observational. ✓
- **Type consistency:** `AdapterParams` (T1 types.ts) ↔ schema `adapterParams` (T1 schema.ts) ↔ `DatanetChoice.adapterParams` consumed by `buildStrategyConfig` (T2) ↔ written as the policy's `adapterParams`, which Plan A's `src/config/schema.ts` accepts (`adapterParams: z.record(z.string(), z.unknown()).optional()` — the onboarding emits a subset object, a record accepts it); `SYSTEM` exported (T3) ↔ asserted in agent.test (T3). ✓
- **Decomposition:** schema/type (T1) + build (T2) are pure/unit-tested; the agent change is a prompt + the already-validated finalize path (T3); conversational quality is manual (T4). Mock model in tests, no live LLM. ✓
- **Plan A dependency:** config schema already accepts `adapterParams` (merged); the `gdelt` adapter already reads focus/angle/brief. ✓
