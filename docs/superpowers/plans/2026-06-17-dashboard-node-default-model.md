# Dashboard-selectable Node Default Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator pick the node default LLM `{provider, model}` from the dashboard (config-driven, overriding the env `LLM_PROVIDER` default), taking effect with no restart for both cycle scoring and the Assistant/onboarding chat.

**Architecture:** Add optional `config.defaultModel` to `StrategyConfig`. A pure `effectiveDefault()` resolver picks the node default = `config.defaultModel` (when its provider has an env key) else the env `LLM_PROVIDER` default. The cycle reads it live via the existing hot-reload; the Assistant/onboarding chat changes from a once-built `chatModel` to a per-request `resolveChatModel()` thunk. Keys stay env-only; the dashboard picker (mirroring the per-datanet one) shows only keyed providers.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import extensions), Zod, `@ai-sdk/*` via `resolveModel`, vitest; web is React + Vite (own vitest).

**Spec:** `docs/superpowers/specs/2026-06-17-dashboard-node-default-model-design.md`

> Worktree root: `/Users/anajuliabittencourt/code/orquestra/.claude/worktrees/nifty-munching-waffle`. Branch `feat/dashboard-node-default` (already created). Run all commands from the root.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/config/schema.ts` | modify | Add optional `defaultModel: { provider, model }` to `StrategyConfigSchema`. |
| `src/config/schema.test.ts` | modify | Assert `defaultModel` parses / rejects unknown provider / absent is valid. |
| `src/llm/effectiveDefault.ts` | create | Pure resolver: config default (if keyed) else env default; reports fallback. |
| `src/llm/effectiveDefault.test.ts` | create | Table-driven: override-when-keyed, fallback-when-keyless, env-when-absent. |
| `src/index.ts` | modify | Compute env default; pass a `resolveChatModel` thunk to the dashboard; pass env default + registry to the cycle (effective default derived live in wiring). |
| `src/dashboard/server.ts` | modify | `DashboardOpts.resolveChatModel?: () => LanguageModel \| null`; chat/onboarding handlers call it per request. |
| `src/runtime/wiring.ts` | modify | Derive the cycle's default provider/model/key from `effectiveDefault(w.config.defaultModel, …)` at scorer-resolution time (hot-reloaded). |
| `web/src/api.ts` | modify | Extend the config type with `defaultModel?`. |
| `web/src/components/StrategyTab.tsx` | modify | Node-level provider+model picker (mirrors the per-datanet one), writes `config.defaultModel`. |

---

### Task 1: Add `defaultModel` to the config schema

**Files:**
- Modify: `src/config/schema.ts`
- Test: `src/config/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Read `src/config/schema.ts` first to confirm the import of `LlmProviderEnum` (the per-datanet `model` field already uses it — reuse that import). In `src/config/schema.test.ts`, add (build the base config from the existing valid-config fixture the other tests in that file use — read the file and copy its shape, do NOT invent fields):

```ts
  it('accepts an optional top-level defaultModel', () => {
    const cfg = StrategyConfigSchema.parse({
      ...minimalValidConfig,
      defaultModel: { provider: 'usepod', model: 'deepseek-v3.2' },
    })
    expect(cfg.defaultModel).toEqual({ provider: 'usepod', model: 'deepseek-v3.2' })
  })

  it('rejects a defaultModel with an unknown provider', () => {
    expect(() => StrategyConfigSchema.parse({
      ...minimalValidConfig,
      defaultModel: { provider: 'mistral-inc', model: 'x' },
    })).toThrow()
  })

  it('treats defaultModel as optional (absent is valid)', () => {
    const cfg = StrategyConfigSchema.parse({ ...minimalValidConfig })
    expect(cfg.defaultModel).toBeUndefined()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/config/schema.test.ts`
Expected: FAIL — `defaultModel` is stripped (unknown key) so the first test's `toEqual` fails / it's `undefined`; the reject test does not throw.

- [ ] **Step 3: Add the schema field**

In `src/config/schema.ts`, add to the top-level `StrategyConfigSchema` object (alongside `horizonDays`, `budget`, `datanets`, etc. — NOT inside `datanets`):

```ts
    // Node default LLM model — the dashboard-selectable fallback used wherever there is
    // no per-datanet `model` override (scoring) and by the Assistant/onboarding chat.
    // Absent ⇒ the env LLM_PROVIDER default. `provider` must be a known LlmProvider.
    defaultModel: z.object({ provider: LlmProviderEnum, model: z.string().min(1) }).optional(),
```

(`LlmProviderEnum` is imported from `../llm/model.js` — the per-datanet `model` field already imports it; reuse that import.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/config/schema.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/config/schema.test.ts
git commit -m "feat(config): add optional top-level defaultModel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `effectiveDefault` resolver

**Files:**
- Create: `src/llm/effectiveDefault.ts`
- Test: `src/llm/effectiveDefault.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/llm/effectiveDefault.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { effectiveDefault } from './effectiveDefault.js'
import type { LlmProvider } from './model.js'

const reg = (entries: [LlmProvider, string][]) => new Map<LlmProvider, string>(entries)

describe('effectiveDefault', () => {
  it('uses the config default when its provider has a key', () => {
    const r = effectiveDefault({
      configDefault: { provider: 'usepod', model: 'deepseek-v3.2' },
      registry: reg([['usepod', 'tok'], ['virtuals', 'acp-x']]),
      envProvider: 'virtuals', envModel: 'claude-opus-4-8',
    })
    expect(r).toEqual({ provider: 'usepod', model: 'deepseek-v3.2', key: 'tok' })
  })

  it('falls back to the env default (with a reason) when the config provider has no key', () => {
    const r = effectiveDefault({
      configDefault: { provider: 'usepod', model: 'deepseek-v3.2' },
      registry: reg([['virtuals', 'acp-x']]),
      envProvider: 'virtuals', envModel: 'claude-opus-4-8',
    })
    expect(r.provider).toBe('virtuals')
    expect(r.model).toBe('claude-opus-4-8')
    expect(r.key).toBe('acp-x')
    expect(r.usedFallback).toMatch(/usepod/)
  })

  it('uses the env default when no config default is set', () => {
    const r = effectiveDefault({
      configDefault: undefined,
      registry: reg([['virtuals', 'acp-x']]),
      envProvider: 'virtuals', envModel: 'claude-opus-4-8',
    })
    expect(r).toEqual({ provider: 'virtuals', model: 'claude-opus-4-8', key: 'acp-x' })
  })

  it('returns an empty key when even the env default has no key (caller treats as unavailable)', () => {
    const r = effectiveDefault({
      configDefault: undefined,
      registry: reg([]),
      envProvider: 'anthropic', envModel: 'claude-opus-4-7',
    })
    expect(r.key).toBe('')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/llm/effectiveDefault.test.ts`
Expected: FAIL — module `./effectiveDefault.js` not found.

- [ ] **Step 3: Implement the resolver**

Create `src/llm/effectiveDefault.ts`:

```ts
import type { LlmProvider } from './model.js'

/** Resolve the node default model: the dashboard-selected `config.defaultModel` when its
 *  provider has an env key, else the env LLM_PROVIDER default. Keys come ONLY from the
 *  env-built registry (ADR 0002). `key === ''` means even the env default is unkeyed —
 *  the caller treats that as "default model unavailable".
 *
 *  Why fall back instead of erroring on a keyless config default: a stale dashboard pick
 *  (its provider's key later removed from env) must never brick scoring + the assistant. */
export function effectiveDefault(args: {
  configDefault?: { provider: LlmProvider; model: string }
  registry: Map<LlmProvider, string>
  envProvider: LlmProvider
  envModel: string
}): { provider: LlmProvider; model: string; key: string; usedFallback?: string } {
  const { configDefault, registry, envProvider, envModel } = args
  if (configDefault) {
    const k = registry.get(configDefault.provider)
    if (k) return { provider: configDefault.provider, model: configDefault.model, key: k }
    return {
      provider: envProvider,
      model: envModel,
      key: registry.get(envProvider) ?? '',
      usedFallback: `default provider ${configDefault.provider} has no API key; using env default ${envProvider}`,
    }
  }
  return { provider: envProvider, model: envModel, key: registry.get(envProvider) ?? '' }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/llm/effectiveDefault.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/llm/effectiveDefault.ts src/llm/effectiveDefault.test.ts
git commit -m "feat(llm): effectiveDefault resolver (config default over env, keyless->env fallback)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Per-request `resolveChatModel` thunk (Assistant + onboarding)

**Files:**
- Modify: `src/dashboard/server.ts` (`DashboardOpts` + the two chat handlers)
- Modify: `src/index.ts` (build + pass the thunk)
- Test: `src/dashboard/server.test.ts`

- [ ] **Step 1: Write the failing test**

Read `src/dashboard/server.test.ts` for the existing harness (how it constructs the server + calls `/api/strategy/chat`). Add a test asserting the chat handler calls `resolveChatModel()` per request and 503s when it returns null, mirroring the file's existing dashboard-start helper names exactly (do NOT invent helpers):

```ts
  it('strategy chat uses resolveChatModel() per request (503 when it returns null)', async () => {
    const { server, baseUrl } = await startTestDashboard({ resolveChatModel: () => null })
    try {
      const res = await fetch(`${baseUrl}/api/strategy/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(res.status).toBe(503)
    } finally { server.close() }
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/dashboard/server.test.ts && npm run typecheck`
Expected: FAIL — `resolveChatModel` is not a known `DashboardOpts` field (typecheck error) / the handler still reads `opts.chatModel`.

- [ ] **Step 3: Implement — DashboardOpts + handlers**

In `src/dashboard/server.ts`:

(a) In the `DashboardOpts` type, REPLACE the `chatModel?: LanguageModel` field with:

```ts
  /** Resolve the current node-default chat model PER REQUEST (so a dashboard
   *  defaultModel change takes effect with no restart). Returns null when the
   *  effective default has no API key — handlers 503. */
  resolveChatModel?: () => LanguageModel | null
```

(b) In the `/api/onboarding/chat` handler (currently line ~188), change:

```ts
        const turn = opts.onboardingTurn ?? (opts.chatModel ? defaultOnboardingTurn(opts.chatModel) : null)
```

to:

```ts
        const chatModel = opts.resolveChatModel?.() ?? null
        const turn = opts.onboardingTurn ?? (chatModel ? defaultOnboardingTurn(chatModel) : null)
```

(c) In the `/api/strategy/chat` handler (currently line ~225), change:

```ts
        if (!opts.chatModel) { json(res, 503, { error: 'strategy chat unavailable — node started without an LLM model' }); return }
```

to:

```ts
        const chatModel = opts.resolveChatModel?.() ?? null
        if (!chatModel) { json(res, 503, { error: 'strategy chat unavailable — no LLM model (set a node default with a configured provider key)' }); return }
```

and update the `runStrategyChat({ ..., model: opts.chatModel })` call (line ~239) to `model: chatModel`.

(d) In the `chatAvailable` flag (currently `Boolean(opts.onboardingTurn ?? opts.chatModel)`, line ~278) change to:

```ts
        chatAvailable: Boolean(opts.onboardingTurn ?? opts.resolveChatModel?.()),
```

- [ ] **Step 4: Implement — build the thunk in index.ts**

In `src/index.ts`, replace the default-model construction (lines 132-136):

```ts
  const providerKeyRegistry = buildProviderKeyRegistry(process.env)
  const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider
  const defaultKey = providerKeyRegistry.get(provider) ?? ''
  const defaultModel = DEFAULT_MODEL[provider]
  const model = resolveModel(provider, defaultKey, defaultModel)
```

with:

```ts
  const providerKeyRegistry = buildProviderKeyRegistry(process.env)
  const envProvider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider
  const envModel = DEFAULT_MODEL[envProvider]
  // Non-chat default model (mint/panel/learn/adapters): env default at startup.
  const envDefaultKey = providerKeyRegistry.get(envProvider) ?? ''
  const model = resolveModel(envProvider, envDefaultKey, envModel)
  // Per-request node-default CHAT model: re-resolve from the CURRENT config.defaultModel
  // (hot — a dashboard change takes effect with no restart) + the env-only key registry.
  // null when even the effective default has no key (handlers 503). loadConfig is tolerant:
  // a fresh node with no config yet falls back to the env default (bootstrap).
  const resolveChatModel = (): ReturnType<typeof resolveModel> | null => {
    let configDefault: { provider: LlmProvider; model: string } | undefined
    try { configDefault = loadConfig(DATA_DIR).defaultModel } catch { configDefault = undefined }
    const eff = effectiveDefault({ configDefault, registry: providerKeyRegistry, envProvider, envModel })
    if (eff.usedFallback) console.error(`orquestra: ${eff.usedFallback}`)
    return eff.key ? resolveModel(eff.provider, eff.key, eff.model) : null
  }
```

Add `import { effectiveDefault } from './llm/effectiveDefault.js'` (loadConfig already imported). Update the `startDashboard(..., { chatModel: model, availableProviders })` call (line 142) to `{ resolveChatModel, availableProviders: [...providerKeyRegistry.keys()] }`.

Update the `CycleWiring` object (lines ~189-194): keep `model`, set `defaultProvider: envProvider`, `defaultModel: envModel` (these are the ENV fallback inputs `effectiveDefault` consumes in Task 4). If the old code referenced `provider`/`defaultKey`/`defaultModel` names elsewhere, reconcile to `envProvider`/`envModel`.

- [ ] **Step 5: Run the test + typecheck**

Run: `npx vitest run src/dashboard/server.test.ts`
Expected: the new server test PASSES. `npm run typecheck` may still be RED on `src/runtime/wiring.ts` until Task 4 if any signature shifts — if index.ts alone typechecks clean here, good; otherwise it goes clean at Task 4. Do not over-fix here.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/server.ts src/index.ts src/dashboard/server.test.ts
git commit -m "feat(dashboard): resolve the chat model per request (no restart on default change)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Cycle scoring default follows `config.defaultModel` (hot-reloaded)

**Files:**
- Modify: `src/runtime/wiring.ts` (derive effective default live)
- Test: `src/runtime/wiring.test.ts`

- [ ] **Step 1: Understand the current wiring**

Read `src/runtime/wiring.ts` for how `voteScorerFor` builds the default scorer: it uses `w.defaultProvider` / `w.defaultModel` (env) + `w.providerKeyRegistry` via `resolveScoringModel`. The env default must become the FALLBACK input; the live `w.config.defaultModel` must win when keyed.

- [ ] **Step 2: Write the failing test**

In `src/runtime/wiring.test.ts`, mirror the existing `voteScorerFor`/`buildCycleDeps` harness (the per-datanet model tests already build wiring with `providerKeyRegistry`/`defaultProvider`/`defaultModel` — reuse that exact helper). If the file's wiring tests inject a resolver spy for `resolveScoringModel`, assert the provider passed; otherwise assert the resolved scorer is present and add the spy following the file's per-datanet test pattern:

```ts
  it('the default scorer follows config.defaultModel when set (hot, over the env default)', () => {
    const w = makeWiring({
      providerKeyRegistry: new Map([['virtuals', 'acp-x'], ['usepod', 'tok']]),
      defaultProvider: 'virtuals',
      defaultModel: 'claude-opus-4-8',
      config: cfgWith({ defaultModel: { provider: 'usepod', model: 'deepseek-v3.2' }, datanets: { '9': { vote: true } } }),
    })
    const deps = buildCycleDeps(w)
    const r = deps.voteScorerFor('9')   // datanet 9 has NO per-datanet model
    expect('scorer' in r).toBe(true)    // resolves via the config default (usepod, keyed)
  })
```

- [ ] **Step 3: Run the test to verify it fails (or is inconclusive without the spy)**

Run: `npx vitest run src/runtime/wiring.test.ts`
Expected: before the change, `voteScorerFor('9')` resolves via the ENV default (`virtuals`), not `usepod`. If `voteScorerFor` returns the scorer opaquely, make the assertion meaningful by spying on `resolveScoringModel` (reuse the injected-resolver pattern the per-datanet tests already use in this file) and assert the `defaultProvider` passed is `usepod` after the change / `virtuals` before. The failing signal is the provider mismatch.

- [ ] **Step 4: Implement — derive the effective default in wiring**

In `src/runtime/wiring.ts`, in `voteScorerFor` (or wherever the per-datanet-or-default model is resolved), BEFORE calling `resolveScoringModel`, compute the live effective node default and pass it as the default inputs:

```ts
    const eff = effectiveDefault({
      configDefault: w.config.defaultModel,
      registry: w.providerKeyRegistry,
      envProvider: w.defaultProvider,
      envModel: w.defaultModel,
    })
```

Pass `eff.provider` / `eff.model` (and `eff.key` if the resolution path needs the key directly) into `resolveScoringModel` as the default provider/model — replacing the direct use of `w.defaultProvider`/`w.defaultModel` as the default. Add `import { effectiveDefault } from '../llm/effectiveDefault.js'`. `w.config` is hot-reloaded, so this recomputes as `config.defaultModel` changes. (`w.defaultProvider`/`w.defaultModel` remain the ENV fallback inputs.)

- [ ] **Step 5: Run the test + full typecheck**

Run: `npx vitest run src/runtime/wiring.test.ts && npm run typecheck`
Expected: PASS; typecheck CLEAN across index.ts + wiring.ts + server.ts.

> NOTE for the executor: mint/panel/learn/adapters keep the ENV default model (they consume the startup-built `model`); only vote scoring + the assistant chat follow `config.defaultModel`. That matches the spec's scope. Record this in your report.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/wiring.ts src/runtime/wiring.test.ts
git commit -m "feat(cycle): vote scoring default follows config.defaultModel (hot, over env)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Dashboard node-default picker

**Files:**
- Modify: `web/src/api.ts` (config type)
- Modify: `web/src/components/StrategyTab.tsx` (picker UI)

- [ ] **Step 1: Extend the web config type**

Read `web/src/api.ts` for the strategy-config type StrategyTab edits (the one with `datanets`). Add an optional field mirroring the per-datanet model shape:

```ts
  defaultModel?: { provider: string; model: string }
```

- [ ] **Step 2: Add the node-level picker (mirror the per-datanet one)**

Read `web/src/components/StrategyTab.tsx` for the EXISTING per-datanet provider+model control (the `<select>` of providers from `/api/models` + the free-text model `<input>`, writing `config.datanets[id].model`, incl. the "no key configured" stale-provider option). Add a NODE-LEVEL copy at the TOP of the tab (above the per-datanet list), bound to `config.defaultModel`:
- Provider `<select>`: options = the `providers` state from `loadModels()` + a "node default (env)" empty option meaning "unset `defaultModel`". If the persisted `defaultModel.provider` is not in `providers` (key removed), render it as an extra selected option labeled `<provider> (no key configured)` — mirror the per-datanet picker exactly.
- Model `<input>`: free-text, placeholder = the selected provider's `models[0]`; empty allowed while editing.
- On change: set `candidate.defaultModel = { provider, model }`, or delete `candidate.defaultModel` when the empty "node default (env)" option is chosen. Reuse the existing candidate-update + Save mechanism (read how the per-datanet picker writes and mirror it).

Label it clearly, e.g. `Node default model (used where a datanet has no override, and by the assistant)`.

- [ ] **Step 3: Verify web typecheck + build**

Run: `npm --prefix web run typecheck && npm --prefix web run build`
Expected: PASS (the picker compiles; no new web test harness — the web vitest globs `*.test.ts`, this is `.tsx` UI, verified via typecheck + build, matching how the per-datanet picker was verified).

- [ ] **Step 4: Commit**

```bash
git add web/src/api.ts web/src/components/StrategyTab.tsx
git commit -m "feat(web): node-default model picker in StrategyTab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full gate

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS — typecheck clean; full vitest suite green (incl. the new schema/effectiveDefault/server/wiring tests); build (backend `tsc` + web SPA) succeeds.

- [ ] **Step 2: Commit any final fixups (only if needed)**

```bash
git add -A
git commit -m "test: fixups for node-default model wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Manual smoke (optional)**

Set `config.defaultModel = { provider: 'usepod', model: 'deepseek-v3.2' }` via the dashboard Strategy tab and Save; the Assistant chat then succeeds against usepod (no restart), and a datanet with no per-datanet override scores via usepod. Unset it → reverts to the env default. (This is the live fix for the virtuals-402 assistant breakage.)

---

## Self-Review

- **Spec coverage:** §Design 1 (config field) → Task 1. §2 (`effectiveDefault`) → Task 2. §3 (cycle scoring follows config default, hot) → Task 4. §4 (per-request `resolveChatModel` for assistant + onboarding) → Task 3. §5 (dashboard picker + web type) → Task 5. §6 (security: keys env-only, picker names-only) → preserved (no key field added; `/api/models` unchanged). Testing section → Tasks 1-5. ✓ Scope note (Task 4): mint/panel/learn/adapters keep the ENV default — matches the spec's "assistant + scoring" scope; documented, not a gap.
- **Placeholder scan:** none — every code step has verbatim code; every run step has an exact command + expected result. Where a test must adapt to an existing harness (schema fixture, server/wiring helpers), the step names the concrete existing pattern to mirror and forbids inventing helpers. ✓
- **Type consistency:** `effectiveDefault({configDefault, registry, envProvider, envModel}) → {provider, model, key, usedFallback?}` defined in Task 2, consumed identically in Task 3 (index.ts thunk) + Task 4 (wiring). `config.defaultModel: {provider, model}` shape identical across schema (1), resolver input (2), thunk (3), wiring (4), web type (5). `DashboardOpts.resolveChatModel: () => LanguageModel | null` defined + built in Task 3. ✓
- **Ordering note:** typecheck is intentionally RED mid-flow (Task 3 reshapes index.ts/server.ts before wiring.ts is updated) and goes CLEAN at Task 4 Step 5; called out in those tasks.
