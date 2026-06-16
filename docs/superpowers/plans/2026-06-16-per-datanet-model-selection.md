# Per-datanet Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan. Each task is a TDD loop (write failing test → run it → minimal implementation → run test → commit). Do not skip the run-and-observe-failure step; do not batch commits.

**Goal:** Let the operator assign a `{ provider, model }` to each datanet so the voting scorer runs on a per-datanet model (e.g. robotics on `google`/Gemini, others on `virtuals`/Claude), while keeping every LLM key in the environment only — the dashboard picks from providers whose key is present, never enters keys. This is **Phase A** of the per-datanet-model + Gemini-video-voting design (`docs/superpowers/specs/2026-06-16-robotics-video-voting-design.md`). It also defines the shared types Phase B (video ingest) depends on, but does NOT implement video detection/ingest.

**Architecture:** A `model?: { provider, model }` override is added to each `DatanetPolicy` (Zod, `.strict()`). At startup `index.ts` builds a **provider key registry** (`Map<LlmProvider, string>`) from per-provider env vars plus the back-compat `LLM_PROVIDER`/`LLM_API_KEY` default. A pure `resolveScoringModel({ policyModel, isVideo, registry, defaultProvider, defaultModel })` implements the resolution order (explicit policy → video default → node default) and returns either `{ model }` or `{ skip: reason }`. The wiring exposes a **per-datanet** `voteScorerFor(datanetId)` factory on `CycleDeps` (replacing the single global `voteScorer`); `runCycle` calls it and, on a `{ skip }` result, records the reason and skips that datanet's vote scoring — reusing the existing per-datanet skip/record mechanism. The dashboard gains a read-only `GET /api/models` endpoint that lists providers with a key (names only, never secrets), and `StrategyTab.tsx` adds a per-datanet provider+model picker that writes `config.datanets[id].model`.

**Tech Stack:** TypeScript (strict, ESM, `NodeNext`, `.js` import extensions), Zod, Vercel AI SDK (`@ai-sdk/anthropic | openai | google`), Node `node:http` dashboard, React 19 + Vite web SPA. Tests: vitest, colocated `*.test.ts`. Backend tests via `npm test` / `npx vitest run <file>`; web tests via `npm --prefix web test`.

---

## File Structure

| File | Create/Modify | Responsibility |
| --- | --- | --- |
| `src/llm/model.ts` | Modify | Export `LlmProviderEnum` (Zod) + `DEFAULT_MODEL` + `KNOWN_MODELS` (per-provider seed slug lists for the picker). `resolveModel` unchanged. |
| `src/llm/model.test.ts` | Create | Assert `LlmProviderEnum` values match the `LlmProvider` union; `KNOWN_MODELS` covers every provider. |
| `src/config/schema.ts` | Modify | Add `model?: { provider, model }` to `DatanetPolicy` using `LlmProviderEnum`. |
| `src/config/schema.test.ts` | Modify | Tests: `model` override parses; unknown provider rejected; empty model string rejected; absent `model` still parses. |
| `src/llm/registry.ts` | Create | `buildProviderKeyRegistry(env)` → `Map<LlmProvider, string>` from `LLM_KEY_*` + back-compat `LLM_PROVIDER`/`LLM_API_KEY`. |
| `src/llm/registry.test.ts` | Create | Tests: per-provider keys; back-compat default; default not clobbered; empty env → empty map. |
| `src/llm/resolveScoringModel.ts` | Create | Pure `resolveScoringModel(...)` → `{ model } | { skip }` implementing the resolution order. |
| `src/llm/resolveScoringModel.test.ts` | Create | Table-driven tests for the full resolution order. |
| `src/voter/types.ts` | Modify | (Shared with Phase B) `VoterPod` gains `mediaUrl?: string` + `mediaType?: string`. |
| `src/runtime/cycle.ts` | Modify | `CycleDeps.voteScorer` → `voteScorerFor(datanetId)` returning `{ scorer } | { skip }`; `runCycle` records the skip and skips scoring. |
| `src/runtime/cycle.test.ts` | Create | Test: a `{ skip }` from `voteScorerFor` records a skip activity and casts no votes; a `{ scorer }` votes normally. |
| `src/runtime/wiring.ts` | Modify | Build the registry-backed per-datanet `voteScorerFor` in `buildCycleDeps`; add `providerKeyRegistry` + `defaultProvider`/`defaultModel` to `CycleWiring`. |
| `src/runtime/wiring.test.ts` | Create/Modify | Test: `voteScorerFor` resolves a datanet's policy model; a no-key policy model → `{ skip }`. |
| `src/index.ts` | Modify | Build the registry at startup; pass `providerKeyRegistry` + `defaultProvider`/`defaultModel` into `CycleWiring`; pass `availableProviders` into the dashboard. |
| `src/dashboard/server.ts` | Modify | Add `GET /api/models` → providers-with-keys (no secrets); accept an injectable provider list for tests. |
| `src/dashboard/server.test.ts` | Modify | Test: `/api/models` lists only providers with a key and returns no secrets. |
| `web/src/api.ts` | Modify | `ModelsResponse` type + `loadModels()`; `DatanetEntry` gains `model?: { provider, model }`. |
| `web/src/api.test.ts` | Modify | Test: `loadModels()` returns the providers array; tolerates HTTP error. |
| `web/src/components/StrategyTab.tsx` | Modify | Per-datanet provider+model picker reading `/api/models`, writing `config.datanets[id].model`. |
| `.env.example` | Modify | Document `LLM_KEY_ANTHROPIC|OPENAI|GOOGLE|VIRTUALS|SURPLUS`. |

---

## Task 1 — `LlmProviderEnum` + per-provider known-model seeds (src/llm/model.ts)

**Files:**
- Modify: `src/llm/model.ts` (add `LlmProviderEnum` + `KNOWN_MODELS` after `DEFAULT_MODEL`, line 33; keep `resolveModel` lines 35-53 unchanged)
- Create: `src/llm/model.test.ts`
- Test: `src/llm/model.test.ts`

Steps:

- [ ] **Step 1: Write the failing test.** Create `src/llm/model.test.ts`:
  ```ts
  // src/llm/model.test.ts
  import { describe, it, expect } from 'vitest'
  import { LlmProviderEnum, DEFAULT_MODEL, KNOWN_MODELS, type LlmProvider } from './model.js'

  const ALL: LlmProvider[] = ['anthropic', 'openai', 'google', 'surplus', 'virtuals']

  describe('LlmProviderEnum', () => {
    it('matches the LlmProvider union exactly', () => {
      expect([...LlmProviderEnum.options].sort()).toEqual([...ALL].sort())
    })
    it('parses a known provider and rejects an unknown one', () => {
      expect(LlmProviderEnum.parse('google')).toBe('google')
      expect(() => LlmProviderEnum.parse('mistral')).toThrow()
    })
  })

  describe('KNOWN_MODELS', () => {
    it('seeds at least the default model for every provider', () => {
      for (const p of ALL) {
        expect(KNOWN_MODELS[p].length).toBeGreaterThan(0)
        expect(KNOWN_MODELS[p]).toContain(DEFAULT_MODEL[p])
      }
    })
  })
  ```

- [ ] **Step 2: Run it (expect FAIL).** `npx vitest run src/llm/model.test.ts` — expected FAIL: `LlmProviderEnum`/`KNOWN_MODELS` are not exported.

- [ ] **Step 3: Minimal implementation.** In `src/llm/model.ts`, add the `zod` import at the top (after line 4 `import type { LanguageModel } from 'ai'`):
  ```ts
  import { z } from 'zod'
  ```
  Then insert directly after the `DEFAULT_MODEL` const (after line 33):
  ```ts
  /** The LlmProvider union as a Zod enum. The .options array MUST stay in sync with
   *  the `LlmProvider` type above — model.test.ts asserts it. Config + dashboard use
   *  this to validate a provider string. */
  export const LlmProviderEnum = z.enum(['anthropic', 'openai', 'google', 'surplus', 'virtuals'])

  /** Per-provider seed model slugs surfaced by the dashboard picker. Slugs drift, so the
   *  picker also allows free-text — this is only a convenience list, never authoritative
   *  (an unknown slug fails at request time, not here). Always includes DEFAULT_MODEL[p]. */
  export const KNOWN_MODELS: Record<LlmProvider, string[]> = {
    anthropic: ['claude-opus-4-7', 'claude-sonnet-4-5'],
    openai: ['gpt-5.2', 'gpt-5.2-mini'],
    google: ['gemini-3-pro', 'gemini-3-flash'],
    surplus: ['claude-opus-4.8'],
    virtuals: ['claude-opus-4-8', 'gemini-3-flash-preview'],
  }
  ```

- [ ] **Step 4: Run it (expect PASS).** `npx vitest run src/llm/model.test.ts` — expected PASS (4 assertions). Then `npm run typecheck` — expected PASS.

- [ ] **Step 5: Commit.**
  ```sh
  git add src/llm/model.ts src/llm/model.test.ts
  git commit -m "feat(llm): LlmProviderEnum + per-provider known-model seeds

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 2 — `model` override on `DatanetPolicy` (src/config/schema.ts)

**Files:**
- Modify: `src/config/schema.ts` (import `LlmProviderEnum`; add `model` to `DatanetPolicy`, the `.object({...})` at lines 14-27)
- Modify: `src/config/schema.test.ts` (add a `describe('StrategyConfig datanet model override')` block after the `adapterParams` block, line 82)
- Test: `src/config/schema.test.ts`

Steps:

- [ ] **Step 1: Write the failing test.** Append to `src/config/schema.test.ts` (after the closing `})` of the `adapterParams` describe at line 82):
  ```ts
  describe('StrategyConfig datanet model override', () => {
    it('accepts an explicit { provider, model } override on a datanet policy', () => {
      const cfg = StrategyConfigSchema.parse({
        ...valid,
        datanets: { '9': { vote: true, strictness: 'balanced', model: { provider: 'google', model: 'gemini-3-pro' } } },
      })
      const p = cfg.datanets['9'] as { model?: { provider: string; model: string } }
      expect(p.model).toEqual({ provider: 'google', model: 'gemini-3-pro' })
    })
    it('rejects an unknown provider in the model override', () => {
      const bad = { ...valid, datanets: { '9': { vote: true, strictness: 'balanced', model: { provider: 'mistral', model: 'm' } } } }
      expect(() => StrategyConfigSchema.parse(bad)).toThrow()
    })
    it('rejects an empty model string in the model override', () => {
      const bad = { ...valid, datanets: { '9': { vote: true, strictness: 'balanced', model: { provider: 'google', model: '' } } } }
      expect(() => StrategyConfigSchema.parse(bad)).toThrow()
    })
    it('parses a datanet with no model override (absent ⇒ node default)', () => {
      const cfg = StrategyConfigSchema.parse(valid)
      expect((cfg.datanets['9'] as { model?: unknown }).model).toBeUndefined()
    })
  })
  ```

- [ ] **Step 2: Run it (expect FAIL).** `npx vitest run src/config/schema.test.ts` — expected FAIL: `.strict()` rejects the unknown `model` key, so the "accepts" test throws.

- [ ] **Step 3: Minimal implementation.** In `src/config/schema.ts`, add the import after line 2 (`import { z } from 'zod'`):
  ```ts
  import { LlmProviderEnum } from '../llm/model.js'
  ```
  Then add the `model` field inside the `DatanetPolicy` object, immediately after the `mintMode` line (line 25), before the closing `})`:
  ```ts
    // Per-datanet LLM override for the VOTING scorer. Absent ⇒ the node default
    // (LLM_PROVIDER/LLM_API_KEY). provider must be a known LlmProvider; model is a
    // non-empty slug (validated lazily — an unknown slug fails at request time).
    model: z.object({ provider: LlmProviderEnum, model: z.string().min(1) }).optional(),
  ```

- [ ] **Step 4: Run it (expect PASS).** `npx vitest run src/config/schema.test.ts` — expected PASS (existing + 4 new). Then `npm run typecheck` — expected PASS.

- [ ] **Step 5: Commit.**
  ```sh
  git add src/config/schema.ts src/config/schema.test.ts
  git commit -m "feat(config): optional per-datanet model override on DatanetPolicy

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 3 — provider key registry from env (src/llm/registry.ts)

**Files:**
- Create: `src/llm/registry.ts`
- Create: `src/llm/registry.test.ts`
- Test: `src/llm/registry.test.ts`

Steps:

- [ ] **Step 1: Write the failing test.** Create `src/llm/registry.test.ts`:
  ```ts
  // src/llm/registry.test.ts
  import { describe, it, expect } from 'vitest'
  import { buildProviderKeyRegistry } from './registry.js'

  describe('buildProviderKeyRegistry', () => {
    it('reads per-provider LLM_KEY_* vars into the registry', () => {
      const r = buildProviderKeyRegistry({
        LLM_KEY_ANTHROPIC: 'sk-ant', LLM_KEY_OPENAI: 'sk-oai',
        LLM_KEY_GOOGLE: 'goog', LLM_KEY_VIRTUALS: 'acp-x', LLM_KEY_SURPLUS: 'inf_y',
      })
      expect(r.get('anthropic')).toBe('sk-ant')
      expect(r.get('openai')).toBe('sk-oai')
      expect(r.get('google')).toBe('goog')
      expect(r.get('virtuals')).toBe('acp-x')
      expect(r.get('surplus')).toBe('inf_y')
    })

    it('registers LLM_PROVIDER + LLM_API_KEY as the default provider key (back-compat)', () => {
      const r = buildProviderKeyRegistry({ LLM_PROVIDER: 'virtuals', LLM_API_KEY: 'acp-default' })
      expect(r.get('virtuals')).toBe('acp-default')
      expect([...r.keys()]).toEqual(['virtuals'])
    })

    it('defaults the provider to anthropic when LLM_API_KEY is set but LLM_PROVIDER is not', () => {
      const r = buildProviderKeyRegistry({ LLM_API_KEY: 'sk-ant' })
      expect(r.get('anthropic')).toBe('sk-ant')
    })

    it('a per-provider key does NOT clobber an existing default for that provider', () => {
      // explicit LLM_KEY_GOOGLE wins over the legacy default for the same provider
      const r = buildProviderKeyRegistry({ LLM_PROVIDER: 'google', LLM_API_KEY: 'old', LLM_KEY_GOOGLE: 'new' })
      expect(r.get('google')).toBe('new')
    })

    it('ignores blank/whitespace keys and an unknown LLM_PROVIDER', () => {
      const r = buildProviderKeyRegistry({ LLM_KEY_OPENAI: '  ', LLM_PROVIDER: 'mistral', LLM_API_KEY: 'x' })
      expect(r.has('openai')).toBe(false)
      expect(r.size).toBe(0)
    })

    it('empty env → empty registry', () => {
      expect(buildProviderKeyRegistry({}).size).toBe(0)
    })
  })
  ```

- [ ] **Step 2: Run it (expect FAIL).** `npx vitest run src/llm/registry.test.ts` — expected FAIL: `src/llm/registry.ts` does not exist.

- [ ] **Step 3: Minimal implementation.** Create `src/llm/registry.ts`:
  ```ts
  // src/llm/registry.ts — build the provider key registry from env at startup.
  // Keys are read from the ENVIRONMENT ONLY (never the dashboard, never persisted,
  // never logged). The map's keys are `availableProviders`. Per-provider LLM_KEY_*
  // vars win; LLM_PROVIDER + LLM_API_KEY register the DEFAULT provider's key only
  // when that provider has no explicit LLM_KEY_* (back-compat: an operator who set
  // just those keeps working).
  import { LlmProviderEnum, type LlmProvider } from './model.js'

  const ENV_BY_PROVIDER: Record<LlmProvider, string> = {
    anthropic: 'LLM_KEY_ANTHROPIC',
    openai: 'LLM_KEY_OPENAI',
    google: 'LLM_KEY_GOOGLE',
    virtuals: 'LLM_KEY_VIRTUALS',
    surplus: 'LLM_KEY_SURPLUS',
  }

  type Env = Record<string, string | undefined>

  /** Map<provider, apiKey> from env. Blank/whitespace values are ignored. */
  export function buildProviderKeyRegistry(env: Env): Map<LlmProvider, string> {
    const reg = new Map<LlmProvider, string>()
    // 1) per-provider explicit keys (authoritative).
    for (const provider of LlmProviderEnum.options) {
      const v = env[ENV_BY_PROVIDER[provider]]?.trim()
      if (v) reg.set(provider, v)
    }
    // 2) back-compat default: LLM_PROVIDER + LLM_API_KEY → that provider, only if it has
    //    no explicit LLM_KEY_* above. Unknown LLM_PROVIDER (or blank key) is ignored.
    const defKey = env.LLM_API_KEY?.trim()
    const defProviderRaw = env.LLM_PROVIDER?.trim() || 'anthropic'
    const defProvider = LlmProviderEnum.safeParse(defProviderRaw)
    if (defKey && defProvider.success && !reg.has(defProvider.data)) {
      reg.set(defProvider.data, defKey)
    }
    return reg
  }
  ```

- [ ] **Step 4: Run it (expect PASS).** `npx vitest run src/llm/registry.test.ts` — expected PASS (6 tests). Then `npm run typecheck` — expected PASS.

- [ ] **Step 5: Commit.**
  ```sh
  git add src/llm/registry.ts src/llm/registry.test.ts
  git commit -m "feat(llm): provider key registry from env with back-compat default

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 4 — `resolveScoringModel` pure function (src/llm/resolveScoringModel.ts)

**Files:**
- Create: `src/llm/resolveScoringModel.ts`
- Create: `src/llm/resolveScoringModel.test.ts`
- Test: `src/llm/resolveScoringModel.test.ts`

Resolution order (from the spec §A3): (1) explicit `policyModel` → skip if its provider has no key; skip if `isVideo && provider !== 'google'`; else resolve. (2) no policy + `isVideo` → `google`/`gemini-3-pro` (skip if no google key). (3) no policy + text → node default. The function is pure: it takes the registry + defaults and returns `{ model } | { skip }`; it calls `resolveModel` only to materialize the `LanguageModel`.

Steps:

- [ ] **Step 1: Write the failing test.** Create `src/llm/resolveScoringModel.test.ts`:
  ```ts
  // src/llm/resolveScoringModel.test.ts
  import { describe, it, expect } from 'vitest'
  import { resolveScoringModel, VIDEO_DEFAULT_PROVIDER, VIDEO_DEFAULT_MODEL } from './resolveScoringModel.js'
  import type { LlmProvider } from './model.js'

  // A LanguageModel is opaque here; resolveModel returns a real object. We only assert
  // that a `model` came back (vs a `skip`), and inspect the skip reasons by string.
  const reg = (...entries: [LlmProvider, string][]) => new Map<LlmProvider, string>(entries)

  describe('resolveScoringModel', () => {
    const base = { defaultProvider: 'virtuals' as LlmProvider, defaultModel: 'claude-opus-4-8' }

    it('1) explicit policy model with a key → resolves to that model', () => {
      const r = resolveScoringModel({ policyModel: { provider: 'google', model: 'gemini-3-pro' }, isVideo: false, registry: reg(['google', 'g'], ['virtuals', 'v']), ...base })
      expect('model' in r).toBe(true)
    })

    it('1) explicit policy model whose provider has NO key → skip with reason', () => {
      const r = resolveScoringModel({ policyModel: { provider: 'google', model: 'gemini-3-pro' }, isVideo: false, registry: reg(['virtuals', 'v']), ...base })
      expect('skip' in r).toBe(true)
      expect((r as { skip: string }).skip).toContain('google')
    })

    it('1) video pod with an explicit NON-google model → skip (video needs Gemini)', () => {
      const r = resolveScoringModel({ policyModel: { provider: 'virtuals', model: 'claude-opus-4-8' }, isVideo: true, registry: reg(['virtuals', 'v']), ...base })
      expect((r as { skip: string }).skip).toContain('video pod needs a Gemini model')
      expect((r as { skip: string }).skip).toContain('virtuals/claude-opus-4-8')
    })

    it('1) video pod with an explicit google model + key → resolves', () => {
      const r = resolveScoringModel({ policyModel: { provider: 'google', model: 'gemini-3-pro' }, isVideo: true, registry: reg(['google', 'g']), ...base })
      expect('model' in r).toBe(true)
    })

    it('2) no policy + video + google key → resolves to the Gemini video default', () => {
      const r = resolveScoringModel({ policyModel: undefined, isVideo: true, registry: reg(['google', 'g'], ['virtuals', 'v']), ...base })
      expect('model' in r).toBe(true)
      expect(VIDEO_DEFAULT_PROVIDER).toBe('google')
      expect(VIDEO_DEFAULT_MODEL).toBe('gemini-3-pro')
    })

    it('2) no policy + video + NO google key → skip', () => {
      const r = resolveScoringModel({ policyModel: undefined, isVideo: true, registry: reg(['virtuals', 'v']), ...base })
      expect((r as { skip: string }).skip).toContain('video scoring needs a Google API key')
    })

    it('3) no policy + text → resolves to the node default', () => {
      const r = resolveScoringModel({ policyModel: undefined, isVideo: false, registry: reg(['virtuals', 'v']), ...base })
      expect('model' in r).toBe(true)
    })

    it('3) no policy + text + default provider has NO key → skip', () => {
      const r = resolveScoringModel({ policyModel: undefined, isVideo: false, registry: reg(['google', 'g']), ...base })
      expect((r as { skip: string }).skip).toContain('no API key for the node default provider')
    })
  })
  ```

- [ ] **Step 2: Run it (expect FAIL).** `npx vitest run src/llm/resolveScoringModel.test.ts` — expected FAIL: module does not exist.

- [ ] **Step 3: Minimal implementation.** Create `src/llm/resolveScoringModel.ts`:
  ```ts
  // src/llm/resolveScoringModel.ts — pure per-datanet/per-pod scoring-model resolution.
  // Returns { model } to score, or { skip } with an operator-readable reason (reused by
  // the cycle's per-datanet skip/record mechanism — fail-closed, never aborts a cycle).
  // The video branch is here so Phase B (video ingest) only flips `isVideo`; in Phase A
  // callers always pass isVideo=false.
  import type { LanguageModel } from 'ai'
  import { resolveModel, type LlmProvider } from './model.js'

  /** Native video (motion + audio) only works via @ai-sdk/google. See spec §"Model-capability finding". */
  export const VIDEO_DEFAULT_PROVIDER: LlmProvider = 'google'
  export const VIDEO_DEFAULT_MODEL = 'gemini-3-pro'

  export interface ResolveScoringInput {
    /** The datanet's explicit override (config.datanets[id].model), if any. */
    policyModel?: { provider: LlmProvider; model: string }
    /** True when the pod under review is a video (Phase B). Phase A always passes false. */
    isVideo: boolean
    /** provider → apiKey, from buildProviderKeyRegistry. */
    registry: Map<LlmProvider, string>
    /** Node default provider/model (LLM_PROVIDER / its DEFAULT_MODEL). */
    defaultProvider: LlmProvider
    defaultModel: string
  }

  export type ScoringModelResult = { model: LanguageModel } | { skip: string }

  export function resolveScoringModel(input: ResolveScoringInput): ScoringModelResult {
    const { policyModel, isVideo, registry, defaultProvider, defaultModel } = input

    // 1) explicit per-datanet override.
    if (policyModel) {
      if (isVideo && policyModel.provider !== 'google') {
        return { skip: `video pod needs a Gemini model; this datanet is set to ${policyModel.provider}/${policyModel.model}` }
      }
      const key = registry.get(policyModel.provider)
      if (!key) return { skip: `no API key for ${policyModel.provider} (this datanet is set to ${policyModel.provider}/${policyModel.model})` }
      return { model: resolveModel(policyModel.provider, key, policyModel.model) }
    }

    // 2) no override + video → Gemini default.
    if (isVideo) {
      const key = registry.get(VIDEO_DEFAULT_PROVIDER)
      if (!key) return { skip: 'video scoring needs a Google API key (set LLM_KEY_GOOGLE)' }
      return { model: resolveModel(VIDEO_DEFAULT_PROVIDER, key, VIDEO_DEFAULT_MODEL) }
    }

    // 3) no override + text → node default.
    const key = registry.get(defaultProvider)
    if (!key) return { skip: `no API key for the node default provider (${defaultProvider})` }
    return { model: resolveModel(defaultProvider, key, defaultModel) }
  }
  ```

- [ ] **Step 4: Run it (expect PASS).** `npx vitest run src/llm/resolveScoringModel.test.ts` — expected PASS (8 tests). Then `npm run typecheck` — expected PASS.

- [ ] **Step 5: Commit.**
  ```sh
  git add src/llm/resolveScoringModel.ts src/llm/resolveScoringModel.test.ts
  git commit -m "feat(llm): resolveScoringModel — per-datanet/pod resolution order

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 5 — Shared `VoterPod` media fields (src/voter/types.ts)

This is a **shared-contract** change Phase B depends on. It is additive and inert in Phase A (nothing sets the fields yet), so it cannot break existing tests. No new test file — it is exercised by the existing `buildVotePrompt` regression test and by typecheck.

**Files:**
- Modify: `src/voter/types.ts` (extend `VoterPod`, the interface at lines 6-13)
- Test: `npm run typecheck` (no behavior change to assert in Phase A)

Steps:

- [ ] **Step 1: Implement the additive type change.** In `src/voter/types.ts`, add two optional fields inside `VoterPod`, after the `url?: string` line (line 12), before the closing `}`:
  ```ts
    /** (Phase B) The pod's media URL when the pod is a video (Content-Type video/*).
     *  Distinct from the text `description`; the scorer hands this to a multimodal model. */
    mediaUrl?: string
    /** (Phase B) The media MIME type captured at detection (e.g. 'video/mp4'). */
    mediaType?: string
  ```

- [ ] **Step 2: Verify.** `npm run typecheck` — expected PASS. `npx vitest run src/voter/score.test.ts` — expected PASS (existing `buildVotePrompt` tests unaffected).

- [ ] **Step 3: Commit.**
  ```sh
  git add src/voter/types.ts
  git commit -m "feat(voter): VoterPod media fields (shared contract for Phase B)

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 6 — `CycleDeps.voteScorerFor` factory + skip handling (src/runtime/cycle.ts)

Replace the single `voteScorer: PodScorer` on `CycleDeps` with a per-datanet factory `voteScorerFor(datanetId): { scorer: PodScorer } | { skip: string }`. In `runCycle`, where it currently calls `selectVotes(..., deps.voteScorer)` (line 225), resolve the scorer first; on `{ skip }` record the reason and skip scoring (reusing `recordSkip`), on `{ scorer }` proceed.

**Files:**
- Modify: `src/runtime/cycle.ts` (CycleDeps `voteScorer` at line 21; vote-scoring call at lines 223-272)
- Create: `src/runtime/cycle.test.ts` (a focused test for the skip/score branch — the file does not yet exist)
- Test: `src/runtime/cycle.test.ts`

Steps:

- [ ] **Step 1: Write the failing test.** Create `src/runtime/cycle.test.ts`:
  ```ts
  // src/runtime/cycle.test.ts
  import { describe, it, expect, afterEach, vi } from 'vitest'
  import { mkdtempSync, rmSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { runCycle, type CycleDeps } from './cycle.js'
  import type { StrategyConfig } from '../config/schema.js'
  import type { DatanetRubric } from '../rubric/types.js'
  import type { VoterPod, VoteFilter, PodScore } from '../voter/types.js'

  const rubric = { datanetId: '9', name: 'D', goal: 'g', voterRubric: 'v', canVote: true, canMint: false, economics: {}, subnetUuid: '' } as unknown as DatanetRubric
  const pod: VoterPod = { podId: '1', validityEpoch: '1', name: 'p', description: 'd' }
  const filter: VoteFilter = { currentEpoch: null, ownPodIds: [], votedPodIds: [] }

  type Recorded = { kind: string; reason?: string }

  function baseDeps(dataDir: string, over: Partial<CycleDeps>): CycleDeps & { _recorded: Recorded[] } {
    const recorded: Recorded[] = []
    const deps: CycleDeps = {
      dataDir, topN: 12,
      getRubric: async () => rubric,
      getPodsAndFilter: async () => ({ pods: [pod], filter }),
      getAdapter: () => undefined,
      voteScorerFor: () => ({ scorer: { scorePod: async (): Promise<PodScore> => ({ score: 9, reason: 'ok' }) } }),
      candidateScorer: { scoreCandidate: async () => ({ score: 1, reason: 'x' }) },
      seenKeysFor: async () => new Set(),
      executor: { executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0x1' })), executeMint: vi.fn(), executeClaim: vi.fn(), executeGrantAccess: vi.fn() } as unknown as CycleDeps['executor'],
      ledger: { startCycle: () => {}, canVote: () => true, canMint: () => true } as unknown as CycleDeps['ledger'],
      recordVote: () => {}, recordMint: () => {},
      getEmissionsDue: async () => [], seenClaims: async () => new Set(),
      recordActivity: (e) => recorded.push(e as Recorded),
      recordClaim: () => {},
      ...over,
    }
    return Object.assign(deps, { _recorded: recorded })
  }

  const cfg = (): StrategyConfig => ({
    horizonDays: 30, cadenceHours: 6, claimEmissions: false,
    stake: { lockReppo: 0, lockDurationDays: 30 },
    budget: { voteRateMaxPerCycle: 25, mintReppoMax: 100, voteGasEthMax: 1, mintGasEthMax: 1, claimGasEthMax: 1 },
    deliberation: { enabled: false, votePanel: false },
    datanets: { '*': { vote: false, mint: false, strictness: 'balanced', mintMode: 'pin' }, '9': { vote: true, mint: false, strictness: 'balanced', mintMode: 'pin' } } as StrategyConfig['datanets'],
    notes: '',
  })

  describe('runCycle per-datanet vote scorer', () => {
    let dir: string
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    it('votes when voteScorerFor returns a scorer', async () => {
      dir = mkdtempSync(join(tmpdir(), 'orq-cycle-'))
      const deps = baseDeps(dir, {})
      const report = await runCycle(cfg(), 'c1', deps)
      expect(report.datanets[0].votes).toHaveLength(1)
      expect(deps.executor.executeVote).toHaveBeenCalledTimes(1)
    })

    it('records a skip and casts no vote when voteScorerFor returns { skip }', async () => {
      dir = mkdtempSync(join(tmpdir(), 'orq-cycle-'))
      const deps = baseDeps(dir, { voteScorerFor: () => ({ skip: 'no API key for google' }) })
      const report = await runCycle(cfg(), 'c1', deps)
      expect(report.datanets[0].votes).toHaveLength(0)
      expect(deps.executor.executeVote).not.toHaveBeenCalled()
      expect(deps._recorded.some((e) => e.kind === 'skip' && /no API key for google/.test(e.reason ?? ''))).toBe(true)
    })
  })
  ```

- [ ] **Step 2: Run it (expect FAIL).** `npx vitest run src/runtime/cycle.test.ts` — expected FAIL: `voteScorerFor` is not a property of `CycleDeps` (TS error / runtime undefined).

- [ ] **Step 3: Minimal implementation.** In `src/runtime/cycle.ts`:
  - Replace the `voteScorer: PodScorer` line (line 21) with:
    ```ts
    /** Per-datanet vote scorer factory. Returns the scorer to use for THIS datanet, or a
     *  skip reason (e.g. no API key for the datanet's chosen provider) — the cycle records
     *  the skip and casts no votes for the datanet, reusing the per-datanet skip mechanism.
     *  Resolved per datanet so each can run on its own provider/model (wiring.ts). */
    voteScorerFor(datanetId: string): { scorer: PodScorer } | { skip: string }
    ```
  - The current vote-scoring branch (lines 223-272) is:
    ```ts
    } else if (policy.vote && rubric.canVote) {
      const { pods, filter } = await deps.getPodsAndFilter(datanetId)
      const intents = await selectVotes(datanetId, pods, rubric, policy.strictness, filter, deps.voteScorer)
      for (let i = 0; i < intents.length; i++) {
        ...
      }
    }
    ```
    Replace its opening (the `} else if (policy.vote && rubric.canVote) {` line through the `const intents = ...` line) with a scorer-resolution guard that wraps the existing `for` loop in an `else`:
    ```ts
    } else if (policy.vote && rubric.canVote) {
      const scorerResult = deps.voteScorerFor(datanetId)
      if ('skip' in scorerResult) {
        // Per-datanet isolation: an unresolvable scoring model (e.g. no API key for the
        // datanet's chosen provider) skips THIS datanet's voting with a recorded reason —
        // never aborts the cycle. Record when otherwise idle so the dashboard explains it.
        recordSkip(`vote skipped — ${scorerResult.skip}`, { activity: votes.length === 0 })
      } else {
        const { pods, filter } = await deps.getPodsAndFilter(datanetId)
        const intents = await selectVotes(datanetId, pods, rubric, policy.strictness, filter, scorerResult.scorer)
        for (let i = 0; i < intents.length; i++) {
    ```
    The existing `for` loop body and its closing `}` are now nested one level deeper inside the new `else`. After the existing loop's closing `}` (the line before the `// Only surface mint-incapability...` comment at line 274), add ONE extra `}` to close the new `else` block. Confirm brace balance with `npm run typecheck` in Step 4.

- [ ] **Step 4: Run it (expect PASS).** `npx vitest run src/runtime/cycle.test.ts` — expected PASS (2 tests). Then `npm run typecheck` — expected to FAIL ONLY on the now-stale `deps.voteScorer` references in `wiring.ts` (and the previous single-scorer wiring test if present); those are fixed in Task 7. Run the FULL suite (`npm test`) only after Task 7.

- [ ] **Step 5: Commit.**
  ```sh
  git add src/runtime/cycle.ts src/runtime/cycle.test.ts
  git commit -m "feat(cycle): per-datanet voteScorerFor factory with skip-with-reason

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 7 — Wire the per-datanet scorer in `buildCycleDeps` (src/runtime/wiring.ts)

Build `voteScorerFor` from the registry + defaults. For each datanet it: reads `config.datanets[id].model`, calls `resolveScoringModel({ policyModel, isVideo: false, registry, defaultProvider, defaultModel })`, and on `{ model }` builds `createLlmScorer(model, { brief: liveBrief })` wrapped in `createPanelPodScorer(...)` (same wrapping as today). On `{ skip }` it returns the skip straight through. Add `providerKeyRegistry`, `defaultProvider`, `defaultModel` to `CycleWiring`. The mint candidate scorer is unchanged (spec: the override scopes to the voting scorer only) and keeps running on `w.model`.

**Files:**
- Modify: `src/runtime/wiring.ts` (import lines 9-12; CycleWiring interface lines 76-97; buildCycleDeps scorer construction lines 120-132; the `voteScorer` return field line 167)
- Create: `src/runtime/wiring.test.ts` (the file does not yet exist)
- Test: `src/runtime/wiring.test.ts`

Steps:

- [ ] **Step 1: Write the failing test.** Create `src/runtime/wiring.test.ts`:
  ```ts
  // src/runtime/wiring.test.ts
  import { describe, it, expect } from 'vitest'
  import { mkdtempSync, rmSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { buildCycleDeps, type CycleWiring } from './wiring.js'
  import type { StrategyConfig } from '../config/schema.js'
  import type { LlmProvider } from '../llm/model.js'

  function wiring(dir: string): CycleWiring {
    return {
      dataDir: dir,
      config: {
        horizonDays: 30, cadenceHours: 6, claimEmissions: false,
        stake: { lockReppo: 0, lockDurationDays: 30 },
        budget: { voteRateMaxPerCycle: 25, mintReppoMax: 100, voteGasEthMax: 1, mintGasEthMax: 1, claimGasEthMax: 1 },
        deliberation: { enabled: false, votePanel: false },
        datanets: { '*': { vote: false, mint: false, strictness: 'balanced', mintMode: 'pin' } },
        notes: '',
      } as unknown as StrategyConfig,
      model: {} as CycleWiring['model'],
      providerKeyRegistry: new Map<LlmProvider, string>([['virtuals', 'acp-v']]),
      defaultProvider: 'virtuals',
      defaultModel: 'claude-opus-4-8',
      ledger: {} as CycleWiring['ledger'],
      executor: {} as CycleWiring['executor'],
      dedup: { getVotedPodIds: () => [], getMintedKeys: () => [], getClaimedKeys: () => [], getGrantedSubnets: () => [], recordVote: () => {}, recordMint: () => {}, recordClaim: () => {}, recordGrant: () => {}, removeGrant: () => {} } as unknown as CycleWiring['dedup'],
      adapters: [],
    }
  }

  describe('buildCycleDeps voteScorerFor', () => {
    it('resolves a scorer for a datanet using the node default provider', () => {
      const dir = mkdtempSync(join(tmpdir(), 'orq-wire-'))
      try {
        const w = wiring(dir)
        w.config.datanets['9'] = { vote: true, mint: false, strictness: 'balanced', mintMode: 'pin' } as never
        const deps = buildCycleDeps(w)
        expect('scorer' in deps.voteScorerFor('9')).toBe(true)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })

    it('skips a datanet whose policy model has no key in the registry', () => {
      const dir = mkdtempSync(join(tmpdir(), 'orq-wire-'))
      try {
        const w = wiring(dir)
        w.config.datanets['9'] = { vote: true, mint: false, strictness: 'balanced', mintMode: 'pin', model: { provider: 'google', model: 'gemini-3-pro' } } as never
        const deps = buildCycleDeps(w)
        const r = deps.voteScorerFor('9')
        expect('skip' in r).toBe(true)
        expect((r as { skip: string }).skip).toContain('google')
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })
  })
  ```

- [ ] **Step 2: Run it (expect FAIL).** `npx vitest run src/runtime/wiring.test.ts` — expected FAIL: `CycleWiring` has no `providerKeyRegistry`/`defaultProvider`/`defaultModel`; `buildCycleDeps` returns `voteScorer`, not `voteScorerFor`.

- [ ] **Step 3: Minimal implementation.** In `src/runtime/wiring.ts`:
  - Extend the voter-types import (line 9) to add `PodScorer`:
    ```ts
    import type { VoterPod, PodScorer } from '../voter/types.js'
    ```
  - Add the resolver + provider-type imports after the scorer imports (after line 12 `import { createPanelPodScorer, createPanelCandidateScorer } from '../panel/scorers.js'`):
    ```ts
    import { resolveScoringModel } from '../llm/resolveScoringModel.js'
    import type { LlmProvider } from '../llm/model.js'
    ```
  - Add fields to `CycleWiring` (after the `model` field doc/decl at line 79):
    ```ts
    /** provider → apiKey, built once at startup from env (src/llm/registry.ts). The
     *  per-datanet scorer resolves a model from this; an absent key for a datanet's
     *  chosen provider → that datanet's vote is skipped with a recorded reason. */
    providerKeyRegistry: Map<LlmProvider, string>
    /** Node default provider/model — used when a datanet has no `model` override. */
    defaultProvider: LlmProvider
    defaultModel: string
    ```
  - Replace the screen/vote scorer construction block (lines 120-132). The current block is:
    ```ts
    const screenScorer = createLlmScorer(w.model, { brief: liveBrief })
    const getDeliberation = () => w.config.deliberation
    const voteScorer = createPanelPodScorer(screenScorer, { model: w.model, getDeliberation, getBrief: liveBrief, getLessons: liveLessons })
    // Mint base scorer: score the DATASET against the publisher spec, not just the
    // summary line — otherwise every candidate scores low and nothing mints (see
    // src/minter/score.ts). The panel (when enabled) replaces this for mints.
    const candidateBase: CandidateScorer = {
      scoreCandidate: (cand, rub) => {
        const { name, description } = candidateScoreInput(cand)
        return screenScorer.scorePod({ podId: cand.canonicalKey, validityEpoch: '', name, description }, rub)
      },
    }
    const candidateScorer = createPanelCandidateScorer(candidateBase, { model: w.model, getDeliberation, getBrief: liveBrief, getLessons: liveLessons })
    ```
    Replace it with:
    ```ts
    const getDeliberation = () => w.config.deliberation
    // Per-datanet vote scorer: resolve THIS datanet's model (its `model` override, else the
    // node default) against the env key registry, then wrap in the panel exactly as before.
    // A skip (no key for the chosen provider) is returned straight to the cycle, which
    // records it per-datanet. isVideo is false in Phase A (no video detection yet).
    const voteScorerFor = (datanetId: string): { scorer: PodScorer } | { skip: string } => {
      const policyModel = (w.config.datanets[datanetId] as { model?: { provider: LlmProvider; model: string } } | undefined)?.model
      const resolved = resolveScoringModel({
        policyModel, isVideo: false,
        registry: w.providerKeyRegistry, defaultProvider: w.defaultProvider, defaultModel: w.defaultModel,
      })
      if ('skip' in resolved) return { skip: resolved.skip }
      const screen = createLlmScorer(resolved.model, { brief: liveBrief })
      const scorer = createPanelPodScorer(screen, { model: resolved.model, getDeliberation, getBrief: liveBrief, getLessons: liveLessons })
      return { scorer }
    }
    // Mint path is unchanged by per-datanet voting overrides (spec: override scopes to the
    // voting scorer only). Score the DATASET (not just the summary line) on the node default
    // model — otherwise every candidate scores low and nothing mints (src/minter/score.ts).
    const mintScreenScorer = createLlmScorer(w.model, { brief: liveBrief })
    const candidateBase: CandidateScorer = {
      scoreCandidate: (cand, rub) => {
        const { name, description } = candidateScoreInput(cand)
        return mintScreenScorer.scorePod({ podId: cand.canonicalKey, validityEpoch: '', name, description }, rub)
      },
    }
    const candidateScorer = createPanelCandidateScorer(candidateBase, { model: w.model, getDeliberation, getBrief: liveBrief, getLessons: liveLessons })
    ```
  - In the `return { ... }` object of `buildCycleDeps`, replace the `voteScorer,` field (line 167) with:
    ```ts
    voteScorerFor,
    ```

- [ ] **Step 4: Run it (expect PASS).** `npx vitest run src/runtime/wiring.test.ts` — expected PASS (2 tests). Then the full backend suite (cycle + wiring now agree): `npm test` — expected PASS. Then `npm run typecheck` — expected PASS.

- [ ] **Step 5: Commit.**
  ```sh
  git add src/runtime/wiring.ts src/runtime/wiring.test.ts
  git commit -m "feat(wiring): build per-datanet voteScorerFor from the key registry

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 8 — Build the registry at startup (src/index.ts)

Wire the registry + defaults into `CycleWiring`. `index.ts` already computes `provider`/`model`; add the registry and pass the new fields. The `model` (default `LanguageModel`) stays for the screen/learn/panel/adapters; the registry drives the per-datanet vote scorer.

**Files:**
- Modify: `src/index.ts` (imports line 24; `start()` lines 114-121; `CycleWiring` literal lines 168-180)
- Test: covered by `npm test` (wiring/cycle suites) + `npm run typecheck`; `index.ts` is the thin shell and has no unit test.

Steps:

- [ ] **Step 1: Implement.** In `src/index.ts`:
  - Extend the llm import (line 24) to bring in the registry + default model map:
    ```ts
    import { resolveModel, DEFAULT_MODEL, type LlmProvider } from './llm/model.js'
    import { buildProviderKeyRegistry } from './llm/registry.js'
    ```
  - In `start()` after the existing `const provider = ...` / `const model = ...` (lines 114-115), build the registry and the default model slug. This MUST be above the `startDashboard` call (line 121) so the dashboard can receive `availableProviders` (Task 9):
    ```ts
    const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider
    const model = resolveModel(provider, process.env.LLM_API_KEY ?? '')
    // Multi-provider key registry (env-only): the per-datanet vote scorer resolves a model
    // from this. Includes the back-compat LLM_PROVIDER/LLM_API_KEY default.
    const providerKeyRegistry = buildProviderKeyRegistry(process.env)
    const defaultModel = DEFAULT_MODEL[provider]
    ```
  - In the `wiring: CycleWiring = { ... }` literal (lines 168-180), add the three fields next to `model,` (line 170):
    ```ts
    model,
    providerKeyRegistry,
    defaultProvider: provider,
    defaultModel,
    ```

- [ ] **Step 2: Verify.** `npm run typecheck` — expected PASS (CycleWiring now satisfied). `npm test` — expected PASS (full suite). `npm run build` — expected PASS (also builds the web SPA).

- [ ] **Step 3: Commit.**
  ```sh
  git add src/index.ts
  git commit -m "feat(node): build provider key registry at startup, thread into wiring

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 9 — `GET /api/models` endpoint (src/dashboard/server.ts)

A read-only endpoint listing providers **with a key** and their seed model slugs — never keys. The server needs to know which providers have a key; to keep secrets out of the dashboard and tests deterministic, inject an `availableProviders: LlmProvider[]` (the registry's keys) via `DashboardOpts`. In production `index.ts` passes `[...providerKeyRegistry.keys()]`. The endpoint returns `{ providers: [{ provider, hasKey: true, models }] }`.

**Files:**
- Modify: `src/dashboard/server.ts` (import near line 13; `DashboardOpts` lines 340-346; the GET route block near the other GETs, after `/api/datanets` line 299)
- Modify: `src/dashboard/server.test.ts` (add a `describe('GET /api/models')` after the `/api/datanets` describe, line 290)
- Modify: `src/index.ts` (pass `availableProviders` into `startDashboard`)
- Test: `src/dashboard/server.test.ts`

Steps:

- [ ] **Step 1: Write the failing test.** Insert into `src/dashboard/server.test.ts` after the `GET /api/datanets` describe (line 290), before the `network bind` describe:
  ```ts
  describe('GET /api/models', () => {
    let mdir: string
    let mh: DashboardHandle
    beforeEach(async () => {
      mdir = mkdtempSync(join(tmpdir(), 'orq-models-'))
      mh = await startDashboard(mdir, 0, { availableProviders: ['google', 'virtuals'] })
    })
    afterEach(async () => { await mh.close(); rmSync(mdir, { recursive: true, force: true }) })

    const mget = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${mh.port}${path}`)
      return { status: res.status, body: await res.text() }
    }

    it('lists only providers with a key, each with hasKey:true and a models[]', async () => {
      const r = await mget('/api/models')
      expect(r.status).toBe(200)
      const body = JSON.parse(r.body) as { providers: { provider: string; hasKey: boolean; models: string[] }[] }
      const provs = body.providers.map((p) => p.provider).sort()
      expect(provs).toEqual(['google', 'virtuals'])
      for (const p of body.providers) {
        expect(p.hasKey).toBe(true)
        expect(Array.isArray(p.models)).toBe(true)
        expect(p.models.length).toBeGreaterThan(0)
      }
    })

    it('returns NO secrets (no api keys in the body)', async () => {
      const r = await mget('/api/models')
      expect(r.body).not.toMatch(/acp[_-]|inf_|sk-|AIza|api[_-]?key/i)
    })

    it('returns an empty providers list when no provider has a key', async () => {
      const bare = await startDashboard(mdir, 0, {})
      try {
        const res = await fetch(`http://127.0.0.1:${bare.port}/api/models`)
        const body = (await res.json()) as { providers: unknown[] }
        expect(body.providers).toEqual([])
      } finally { await bare.close() }
    })
  })
  ```

- [ ] **Step 2: Run it (expect FAIL).** `npx vitest run src/dashboard/server.test.ts` — expected FAIL: `/api/models` 404s; `availableProviders` is not a `DashboardOpts` field.

- [ ] **Step 3: Minimal implementation.** In `src/dashboard/server.ts`:
  - Add an import (after line 13 `import { StrategyConfigSchema, type StrategyConfig } from '../config/schema.js'`):
    ```ts
    import { KNOWN_MODELS, type LlmProvider } from '../llm/model.js'
    ```
  - Add the field to `DashboardOpts` (after `chatModel?: LanguageModel` at line 341):
    ```ts
    /** Providers whose API key is present in env (the key registry's keys). The
     *  /api/models endpoint lists these — names only, NEVER keys. */
    availableProviders?: LlmProvider[]
    ```
  - Add the GET route alongside the other read endpoints, directly after the `/api/datanets` route (line 299):
    ```ts
    if (url === '/api/models') {
      // Provider/model NAMES only — never keys (ADR 0002: dashboard holds no secrets).
      const providers = (opts.availableProviders ?? []).map((provider) => ({
        provider, hasKey: true as const, models: KNOWN_MODELS[provider],
      }))
      json(res, 200, { providers }); return
    }
    ```

- [ ] **Step 4: Run it (expect PASS).** `npx vitest run src/dashboard/server.test.ts` — expected PASS (existing + 3 new). Then `npm run typecheck` — expected PASS.

- [ ] **Step 5: Pass the providers from `index.ts`.** In `src/index.ts`, the dashboard start (line 121) is currently:
  ```ts
  const dash = dashEnabled ? await startDashboard(DATA_DIR, dashPort, { chatModel: model }) : null
  ```
  Since Task 8 placed `providerKeyRegistry` above this line, pass the provider names:
  ```ts
  const dash = dashEnabled ? await startDashboard(DATA_DIR, dashPort, { chatModel: model, availableProviders: [...providerKeyRegistry.keys()] }) : null
  ```
  Then `npm run typecheck` — expected PASS, and `npm test` — expected PASS.

- [ ] **Step 6: Commit.**
  ```sh
  git add src/dashboard/server.ts src/dashboard/server.test.ts src/index.ts
  git commit -m "feat(dashboard): GET /api/models — providers with keys, no secrets

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 10 — Web API client: `loadModels()` + `DatanetEntry.model` (web/src/api.ts)

**Files:**
- Modify: `web/src/api.ts` (`DatanetEntry` lines 88-97; add `ModelsResponse` + `loadModels` near `saveStrategy`, after line 172)
- Modify: `web/src/api.test.ts` (add a `loadModels` describe; extend the import on line 2)
- Test: `web/src/api.test.ts` (run with `npm --prefix web test`)

Steps:

- [ ] **Step 1: Write the failing test.** In `web/src/api.test.ts`, change the import on line 2 to:
  ```ts
  import { loadAll, loadModels } from './api'
  ```
  Append at the end of the file:
  ```ts
  describe('loadModels', () => {
    it('returns the providers array on a 200', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => res(200, { providers: [{ provider: 'google', hasKey: true, models: ['gemini-3-pro'] }] })))
      const out = await loadModels()
      expect(out.providers[0].provider).toBe('google')
      expect(out.providers[0].models).toContain('gemini-3-pro')
    })
    it('degrades to an empty providers list on an HTTP error', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => res(500, { error: 'boom' })))
      expect((await loadModels()).providers).toEqual([])
    })
    it('degrades to an empty providers list on a network failure', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
      expect((await loadModels()).providers).toEqual([])
    })
  })
  ```

- [ ] **Step 2: Run it (expect FAIL).** `npm --prefix web test` — expected FAIL: `loadModels` is not exported.

- [ ] **Step 3: Minimal implementation.** In `web/src/api.ts`:
  - Add the `model` field to `DatanetEntry` (after `mintMode?: 'pin' | 'url-only'` at line 96, before the closing `}` at line 97):
    ```ts
    /** Per-datanet LLM override for the voting scorer (provider+model). Absent ⇒ node default. */
    model?: { provider: string; model: string }
    ```
  - Add the response type + loader after `saveStrategy` (after line 172):
    ```ts
    // ── Model picker (mirrors GET /api/models — names only, never keys) ──
    export interface ModelProvider { provider: string; hasKey: boolean; models: string[] }
    export interface ModelsResponse { providers: ModelProvider[] }

    /** Providers whose API key is present in the node's env, with seed model slugs.
     *  Degrades to an empty list on any error (no key entry happens in the UI). */
    export async function loadModels(): Promise<ModelsResponse> {
      return getJson<ModelsResponse>('/api/models', { providers: [] })
    }
    ```

- [ ] **Step 4: Run it (expect PASS).** `npm --prefix web test` — expected PASS (existing + 3 new). Then `npm --prefix web run typecheck` — expected PASS.

- [ ] **Step 5: Commit.**
  ```sh
  git add web/src/api.ts web/src/api.test.ts
  git commit -m "feat(web): loadModels() client + DatanetEntry.model field

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 11 — StrategyTab per-datanet provider+model picker (web/src/components/StrategyTab.tsx)

Add a provider+model control to each `NetCard`. The provider dropdown lists `node default` + providers from `/api/models`; the model field is a free-text `<input>` with a `<datalist>` seeded from the chosen provider's `models` (a drifting slug never needs a code change). Writes `config.datanets[id].model = { provider, model }`, or deletes it when provider is cleared. Models are loaded once in `StrategyTab` and passed down.

**Files:**
- Modify: `web/src/components/StrategyTab.tsx` (api import line 2; `StrategyTab` load + prop threading lines 131-156; `NetCard` signature line 54-56, helper after line 67, control after the `net-row` at line 99)
- Test: web vitest is `environment: 'node'` (vite.config.ts) with no jsdom/RTL — component rendering is not unit-tested. Verification is `npm --prefix web run typecheck` + `npm run build` (the web build runs `tsc --noEmit` then `vite build`, catching JSX/type errors). No new test file.

Steps:

- [ ] **Step 1: Implement the model loading + prop threading.** In `web/src/components/StrategyTab.tsx`:
  - Extend the api import (line 2):
    ```ts
    import { type DatanetEntry, loadModels, type ModelProvider } from '../api'
    ```
  - In the `StrategyTab` function (line 131), after `const [adding, setAdding] = useState(false)` (line 134), load providers once (`useEffect`/`useState` are already imported on line 1):
    ```ts
    const [providers, setProviders] = useState<ModelProvider[]>([])
    useEffect(() => { void loadModels().then((r) => setProviders(r.providers)) }, [])
    ```
  - Pass `providers` to each `NetCard` in the `rows.map(...)` (line 156):
    ```tsx
    <NetCard key={id} id={id} d={d} name={netNames[id] ?? netLabel(id, netNames)} edit={edit} providers={providers} />
    ```

- [ ] **Step 2: Implement the `NetCard` picker.** Change the `NetCard` signature (lines 54-56) to accept `providers`:
  ```tsx
  function NetCard({ id, d, name, edit, providers }: {
    id: string; d: DatanetEntry; name: string; edit: Strategy['edit']; providers: ModelProvider[]
  }) {
  ```
  Add a helper inside `NetCard`, after the `setParam` definition (line 67), before `return`:
  ```tsx
  const setModel = (provider: string, model: string) =>
    upd((n) => {
      if (!provider) delete n.model
      else n.model = { provider, model: model || (providers.find((p) => p.provider === provider)?.models[0] ?? '') }
    })
  const curProvider = d.model?.provider ?? ''
  const curModels = providers.find((p) => p.provider === curProvider)?.models ?? []
  ```
  Then add a SECOND `net-row` directly after the existing `net-row` (the one closing at line 99 with the `adapter` + `strictness` fields), so the layout stays two-up:
  ```tsx
  <div className="net-row">
    <label className="field">
      <span>vote model <Tip label="what vote model does">Which LLM scores votes for THIS datanet. Blank = the node's default model. Only providers whose API key is set on the node appear here (keys are never entered in the dashboard). Pick a Gemini (google) model if this datanet's pods are videos.</Tip></span>
      <select value={curProvider} onChange={(e) => setModel(e.target.value, '')}>
        <option value="">node default</option>
        {providers.map((p) => <option key={p.provider} value={p.provider}>{p.provider}</option>)}
      </select>
    </label>
    {curProvider && (
      <label className="field">
        <span>model slug <Tip label="what model slug does">The provider's model id (slugs drift, so free text is allowed). Suggestions come from the node; type any valid slug for {curProvider}.</Tip></span>
        <input type="text" list={`models-${id}`} value={d.model?.model ?? ''} placeholder={curModels[0] ?? 'model id'}
          onChange={(e) => setModel(curProvider, e.target.value)} />
        <datalist id={`models-${id}`}>
          {curModels.map((m) => <option key={m} value={m} />)}
        </datalist>
      </label>
    )}
  </div>
  ```

- [ ] **Step 3: Verify.** `npm --prefix web run typecheck` — expected PASS. `npm run build` — expected PASS (builds backend + web SPA; surfaces any JSX/type error). `npm --prefix web test` — expected PASS (api tests unaffected).

- [ ] **Step 4: Commit.**
  ```sh
  git add web/src/components/StrategyTab.tsx
  git commit -m "feat(web): per-datanet provider+model picker in StrategyTab

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 12 — Document the new env vars (.env.example)

**Files:**
- Modify: `.env.example` (the LLM block; add the per-provider key vars after the `LLM_API_KEY=` line + its onboarding comment)
- Test: none (docs). Verified by reading the file; `npm test` unaffected.

Steps:

- [ ] **Step 1: Implement.** In `.env.example`, after the `LLM_API_KEY=acp-your-virtuals-key` line and its trailing `# Onboarding is an LLM chat...` comment, add:
  ```sh
  # Optional MULTI-PROVIDER keys for per-datanet model selection (dashboard → datanet
  # "vote model"). Set a provider's key here to make it selectable per datanet. These are
  # ADDITIVE to LLM_PROVIDER/LLM_API_KEY above (which still sets the node default). Keys
  # are read from the environment ONLY — never entered in or returned by the dashboard.
  # A google key is REQUIRED to score video pods (only Gemini watches video natively).
  # LLM_KEY_ANTHROPIC=sk-ant-...
  # LLM_KEY_OPENAI=sk-...
  # LLM_KEY_GOOGLE=AIza...
  # LLM_KEY_VIRTUALS=acp-...
  # LLM_KEY_SURPLUS=inf_...
  ```

- [ ] **Step 2: Verify.** `npm test` — expected PASS (no behavior change). `npm run build` — expected PASS.

- [ ] **Step 3: Commit.**
  ```sh
  git add .env.example
  git commit -m "docs(env): document per-provider LLM_KEY_* vars for model selection

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Self-Review

### Spec-coverage checklist (Phase A scope only)

- [x] **A1. Multi-provider key registry (env-only)** — Task 3 (`buildProviderKeyRegistry` from `LLM_KEY_*` + back-compat `LLM_PROVIDER`/`LLM_API_KEY`; blank keys + unknown provider ignored). Built at startup in Task 8. `.env.example` documented in Task 12. Keys never logged (registry is a plain Map; nothing logs it; `util/redact.ts` already scrubs `inf_`/`acp-`/`Bearer`).
- [x] **A2. Config schema `model?: { provider, model }`** — Task 2 (Zod, `LlmProviderEnum` from Task 1, `z.string().min(1)`, `.optional()`, on the `.strict()` `DatanetPolicy`).
- [x] **A3. Per-datanet/per-pod resolution** — Task 4 (`resolveScoringModel` pure function, full order: explicit policy → skip if no key / skip if video+non-google → video default google/gemini-3-pro → node default), threaded through `CycleDeps.voteScorerFor` (Task 6) built in wiring (Task 7) from the registry (Task 8). `isVideo:false` in Phase A.
- [x] **A4. Dashboard picker** — `GET /api/models` providers-with-keys, names only (Task 9); StrategyTab per-datanet provider+model control reading `/api/models`, writing `config.datanets[id].model`, free-text model allowed, no key field (Tasks 10-11).
- [x] **Shared types for Phase B** — `VoterPod.mediaUrl?`/`mediaType?` (Task 5); `LlmProviderEnum`, `model` config field, `buildProviderKeyRegistry`, `resolveScoringModel` (with the `isVideo` branch already wired) all created in Phase A as the contract Phase B builds on.
- [x] **Fail-closed, per-datanet isolation** — `resolveScoringModel` returns `{ skip }`; `runCycle` records it via the existing `recordSkip` mechanism and casts no votes for that datanet, never aborting the cycle (Task 6 test asserts this).
- [x] **Secrets env-only / redacted / never in responses** — registry is built from `process.env` only; `/api/models` returns provider names + `hasKey:true` + model slugs only (Task 9 test asserts no secrets); dashboard never accepts a key (Task 11 picker has no key field).
- NOTE — explicitly OUT of Phase A scope (deferred to Phase B): video detect/ingest (`B1`-`B3`), `generateObjectWithRetry` multimodal, `buildVotePrompt` message parts, `VIDEO_*_BYTES` caps. NOT implemented here; the shared types/registry/resolver they depend on ARE created here.

### Placeholder scan

Result: NO placeholders. No "TBD", "similar to Task N", "add error handling", or "..." stand-ins in any code/test step. Every type and function referenced is defined in a task: `LlmProviderEnum`/`KNOWN_MODELS` (Task 1) used by Tasks 2, 9, 11; `model` config field (Task 2) read in Tasks 7, 11; `buildProviderKeyRegistry` (Task 3) used in Tasks 8, 9; `resolveScoringModel`/`VIDEO_DEFAULT_*` (Task 4) used in Task 7; `VoterPod` media fields (Task 5) inert until Phase B; `voteScorerFor` (Task 6) built in Task 7, consumed in Task 6's `runCycle` edit; `CycleWiring.providerKeyRegistry`/`defaultProvider`/`defaultModel` (Task 7) set in Task 8; `availableProviders` (Task 9) passed in Task 9 Step 5; `loadModels`/`ModelsResponse`/`DatanetEntry.model` (Task 10) used in Task 11. Every code block is verbatim, repo-style (TS ESM with `.js` import extensions, Zod, colocated `*.test.ts`, vitest).

### Type-consistency check (shared contract names/shapes)

- `LlmProvider` union (src/llm/model.ts) ↔ `LlmProviderEnum = z.enum(['anthropic','openai','google','surplus','virtuals'])` — Task 1 test asserts the enum options equal the union members.
- `DatanetPolicy.model?: { provider: LlmProvider; model: string }` (Zod) ↔ web `DatanetEntry.model?: { provider: string; model: string }` — backend validates `provider` against `LlmProviderEnum`; the web type widens `provider` to `string` (the picker only offers valid providers from `/api/models`, and the backend re-validates on Save) — consistent with how web `DatanetEntry.strictness` is `string` while the backend uses the `Strictness` enum.
- Registry shape `Map<LlmProvider, string>` is identical across `buildProviderKeyRegistry` (Task 3), `CycleWiring.providerKeyRegistry` (Task 7), and `resolveScoringModel`'s `registry` param (Task 4).
- `resolveScoringModel({ policyModel, isVideo, registry, defaultProvider, defaultModel }) → { model: LanguageModel } | { skip: string }` — exact signature in Task 4, called with exactly these keys in Task 7.
- `GET /api/models` → `{ providers: { provider: LlmProvider; hasKey: true; models: string[] }[] }` — Task 9 emits this shape; Task 10's `ModelProvider`/`ModelsResponse` mirror it (web `provider` widened to `string`, same rationale as above); never returns keys (Task 9 test).
- `VoterPod` gains `mediaUrl?: string` + `mediaType?: string` (Task 5) — exact names/shapes the Phase B plan consumes.
- `voteScorerFor(datanetId) → { scorer: PodScorer } | { skip: string }` — same discriminated-union shape returned by `resolveScoringModel` (mapped 1:1 in Task 7), consumed by `runCycle` via `'skip' in result` (Task 6).
