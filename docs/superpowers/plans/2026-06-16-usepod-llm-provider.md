# usepod LLM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `usepod` as a 6th per-datanet-selectable LLM provider — OpenAI-compatible with the auth token carried in the URL path — plus redaction of that token.

**Architecture:** Mirror the existing `virtuals`/`surplus` OpenAI-compatible providers in `src/llm/model.ts`, with one twist: usepod's token lives in the base URL path (`https://api.usepod.ai/proxy/<token>/v1`, `api_key` unused), so `resolveModel` interpolates the configured key into the base URL instead of passing it as a header. The provider auto-surfaces in the dashboard picker via the existing registry + `/api/models` (no web change). The token-in-URL must be redacted (`src/util/redact.ts`).

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import extensions), `@ai-sdk/openai` `createOpenAI`, Zod, vitest.

**Spec:** `docs/superpowers/specs/2026-06-16-usepod-llm-provider-design.md`

> All paths are under the worktree root `/Users/anajuliabittencourt/code/orquestra/.claude/worktrees/nifty-munching-waffle`. Branch: `feat/usepod-provider` (already created). Run all commands from the worktree root.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/llm/model.ts` | modify | Add `usepod` to the union + Zod enum + DEFAULT_MODEL + KNOWN_MODELS; `resolveModel` case with token-in-URL base. |
| `src/llm/model.test.ts` | modify | Add `usepod` to the `ALL` exhaustiveness array; assert resolveModel + KNOWN_MODELS for usepod. |
| `src/llm/registry.ts` | modify | Add `usepod: 'LLM_KEY_USEPOD'` to `ENV_BY_PROVIDER` (the `Record<LlmProvider,string>` type forces it). |
| `src/llm/registry.test.ts` | modify | Assert `LLM_KEY_USEPOD` populates the registry. |
| `src/util/redact.ts` | modify | Redact the `api.usepod.ai/proxy/<token>/` path segment. |
| `src/util/redact.test.ts` | modify | Assert the usepod token is redacted; a non-usepod URL is untouched. |
| `.env.example` | modify | Document `LLM_KEY_USEPOD`. |

---

### Task 1: Add `usepod` to the provider union, enum, and model tables

**Files:**
- Modify: `src/llm/model.ts:8` (union), `:39` (enum), `:28-34` (DEFAULT_MODEL), `:44-50` (KNOWN_MODELS)
- Test: `src/llm/model.test.ts:4` (ALL array), new assertions

- [ ] **Step 1: Update the exhaustiveness test to expect `usepod` (this makes it fail)**

In `src/llm/model.test.ts`, change line 4 from:

```ts
const ALL: LlmProvider[] = ['anthropic', 'openai', 'google', 'surplus', 'virtuals']
```

to:

```ts
const ALL: LlmProvider[] = ['anthropic', 'openai', 'google', 'surplus', 'virtuals', 'usepod']
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/llm/model.test.ts`
Expected: FAIL — `LlmProviderEnum matches the LlmProvider union exactly` fails (enum has 5 options, ALL now has 6); the `KNOWN_MODELS` loop also fails on the missing `usepod` key. (TS may also error that `'usepod'` is not assignable to `LlmProvider` — that is the same failing signal.)

- [ ] **Step 3: Add `usepod` to the union, enum, and both model tables**

In `src/llm/model.ts`, change the union (line 8):

```ts
export type LlmProvider = 'anthropic' | 'openai' | 'google' | 'surplus' | 'virtuals' | 'usepod'
```

Add the base-URL prefix constant after the `VIRTUALS_BASE_URL` block (after line 20):

```ts
/** usepod — a decentralized, OpenAI-compatible inference marketplace
 *  (https://usepod.ai). The auth token is carried in the URL PATH, not a header:
 *  the base URL is `<prefix>/<token>/v1` and the OpenAI client's apiKey is unused.
 *  Obtain a token from `POST https://api.usepod.ai/register` (prepaid USDC balance).
 *  Model ids are canonical/host-advertised (e.g. `deepseek-v3.2`); list at
 *  GET <prefix>/<token>/v1/models. */
const USEPOD_BASE_PREFIX = 'https://api.usepod.ai/proxy'
```

Add to `DEFAULT_MODEL` (inside the object at lines 28-34, after the `virtuals` entry):

```ts
  usepod: 'deepseek-v3.2',
```

Update the Zod enum (line 39):

```ts
export const LlmProviderEnum = z.enum(['anthropic', 'openai', 'google', 'surplus', 'virtuals', 'usepod'])
```

Add to `KNOWN_MODELS` (inside the object at lines 44-50, after the `virtuals` entry):

```ts
  usepod: ['deepseek-v3.2', 'qwen-3.5', 'llama-4', 'mistral', 'glm-5.1'],
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/llm/model.test.ts`
Expected: PASS for `LlmProviderEnum` + `KNOWN_MODELS` describes. (The `resolveModel` describe still passes — it iterates a hardcoded provider list that does not yet include usepod; Task 2 adds the usepod resolveModel case + its test.) `npm run typecheck` will FAIL until Task 2 because `resolveModel`'s switch is now non-exhaustive — that is expected and fixed in Task 2.

- [ ] **Step 5: Commit**

```bash
git add src/llm/model.ts src/llm/model.test.ts
git commit -m "feat(llm): register usepod provider in union, enum, model tables

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `resolveModel` case for usepod (token-in-URL)

**Files:**
- Modify: `src/llm/model.ts:52-70` (`resolveModel` switch)
- Test: `src/llm/model.test.ts` (new resolveModel cases)

- [ ] **Step 1: Write the failing test**

In `src/llm/model.test.ts`, add inside the `describe('resolveModel', ...)` block (after the `virtuals` test, before the `throws on an unknown provider` test):

```ts
  it('resolves usepod (OpenAI-compatible, token-in-URL) with a model override', () => {
    expect(resolveModel('usepod', 'tok_test')).toBeTruthy()
    expect(resolveModel('usepod', 'tok_test', 'deepseek-v3.2')).toBeTruthy()
  })

  it('builds the usepod base URL from the token (token in the path, not a header)', () => {
    const m = resolveModel('usepod', 'TOKHERE', 'deepseek-v3.2') as unknown as {
      config?: { baseURL?: string }
    }
    // @ai-sdk/openai stores the configured baseURL on the model's config.
    expect(m.config?.baseURL).toBe('https://api.usepod.ai/proxy/TOKHERE/v1')
  })
```

Also extend the first resolveModel loop test (the `for (const p of ['anthropic', ...])` at lines 27-29) to include usepod:

```ts
    for (const p of ['anthropic', 'openai', 'google', 'surplus', 'virtuals', 'usepod'] as LlmProvider[]) {
      expect(resolveModel(p, 'test-key')).toBeTruthy()
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/llm/model.test.ts`
Expected: FAIL — usepod hits the `default` branch and throws `unknown LLM provider: usepod` (the loop test and the new usepod tests fail). Note: if the base-URL assertion's `m.config?.baseURL` path differs in the installed `@ai-sdk/openai`, keep the two `.toBeTruthy()` assertions as the load-bearing checks and adjust the base-URL probe to whatever the SDK exposes (read `node_modules/@ai-sdk/openai` types); do NOT delete the base-URL intent — assert it on whatever field carries it.

- [ ] **Step 3: Add the usepod case**

In `src/llm/model.ts`, add a `case 'usepod'` to the `resolveModel` switch immediately after the `virtuals` case (after line 64, before the `default`):

```ts
    case 'usepod':
      // OpenAI-compatible, but the auth token is in the URL PATH (api_key unused).
      // The configured key IS the usepod token; interpolate it into the base URL.
      return createOpenAI({
        apiKey: 'unused',
        baseURL: `${USEPOD_BASE_PREFIX}/${apiKey}/v1`,
      })(model ?? DEFAULT_MODEL.usepod)
```

- [ ] **Step 4: Run the test + typecheck to verify they pass**

Run: `npx vitest run src/llm/model.test.ts && npm run typecheck`
Expected: PASS — usepod resolves; the switch is exhaustive again (the `_exhaustive: never` default no longer errors); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/llm/model.ts src/llm/model.test.ts
git commit -m "feat(llm): resolveModel usepod case (OpenAI-compatible, token-in-URL)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Register `LLM_KEY_USEPOD` in the provider key registry

**Files:**
- Modify: `src/llm/registry.ts:9-15` (`ENV_BY_PROVIDER`)
- Test: `src/llm/registry.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/llm/registry.test.ts`, add a test (place it next to the other per-provider env tests):

```ts
  it('registers usepod from LLM_KEY_USEPOD', () => {
    const reg = buildProviderKeyRegistry({ LLM_KEY_USEPOD: 'tok_abc' })
    expect(reg.get('usepod')).toBe('tok_abc')
  })
```

(`buildProviderKeyRegistry` is already imported by the existing tests — reuse the existing import.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/llm/registry.test.ts && npm run typecheck`
Expected: FAIL — typecheck errors that `ENV_BY_PROVIDER` is missing the `usepod` key (the `Record<LlmProvider, string>` type now requires it, since Task 1 added `usepod` to the union); the runtime test also fails (no usepod entry).

- [ ] **Step 3: Add the env mapping**

In `src/llm/registry.ts`, add to `ENV_BY_PROVIDER` (inside the object at lines 9-15, after the `surplus` entry):

```ts
  usepod: 'LLM_KEY_USEPOD',
```

- [ ] **Step 4: Run the test + typecheck to verify they pass**

Run: `npx vitest run src/llm/registry.test.ts && npm run typecheck`
Expected: PASS — registry maps `LLM_KEY_USEPOD` → `usepod`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/llm/registry.ts src/llm/registry.test.ts
git commit -m "feat(llm): map LLM_KEY_USEPOD into the provider key registry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Redact the usepod token-in-URL

**Files:**
- Modify: `src/util/redact.ts:38-65` (`redactSecrets`)
- Test: `src/util/redact.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/util/redact.test.ts`, add:

```ts
  it('redacts the usepod proxy token in a URL path', () => {
    const s = 'request to https://api.usepod.ai/proxy/SECRETTOKEN123/v1/chat/completions failed'
    const out = redactSecrets(s)
    expect(out).not.toContain('SECRETTOKEN123')
    expect(out).toContain('https://api.usepod.ai/proxy/<redacted>')
    expect(out).toContain('/v1/chat/completions') // path after the token is preserved
  })

  it('does not alter a non-usepod URL', () => {
    const s = 'https://example.com/proxy/abc/v1'
    expect(redactSecrets(s)).toBe(s)
  })
```

(`redactSecrets` is already imported by the existing tests; reuse it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/util/redact.test.ts`
Expected: FAIL — `SECRETTOKEN123` is still present (no rule matches the `/proxy/<token>/` path segment yet).

- [ ] **Step 3: Add the redaction rule**

In `src/util/redact.ts`, add a `.replace(...)` to the chain in `redactSecrets` as the last replace before the closing `}` (after the `AIza…` rule at line 64):

```ts
    // usepod carries its auth token in the URL PATH: https://api.usepod.ai/proxy/<token>/v1.
    // No existing rule matches a path segment (the others cover ?key= queries + bearer +
    // inf_/acp_ + LLM key shapes), so redact the token between `/proxy/` and the next `/`.
    .replace(/(api\.usepod\.ai\/proxy\/)[^/\s"']+/gi, '$1<redacted>')
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/util/redact.test.ts`
Expected: PASS — the token becomes `<redacted>`, the trailing `/v1/chat/completions` path is preserved, and a non-usepod URL is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/util/redact.ts src/util/redact.test.ts
git commit -m "feat(redact): scrub the usepod proxy token from URLs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Document `LLM_KEY_USEPOD` and run the full gate

**Files:**
- Modify: `.env.example` (the `LLM_KEY_*` block)

- [ ] **Step 1: Find the existing LLM_KEY block**

Run: `grep -n "LLM_KEY_" .env.example`
Expected: lists the existing `LLM_KEY_ANTHROPIC|OPENAI|GOOGLE|VIRTUALS|SURPLUS` lines (added in the Phase A model-selection work). Note the line of the last `LLM_KEY_*` entry.

- [ ] **Step 2: Add the usepod line**

Immediately after the last `LLM_KEY_*` line in `.env.example`, add:

```
# usepod (https://usepod.ai) — decentralized OpenAI-compatible inference. The value is
# the usepod TOKEN from `POST https://api.usepod.ai/register` (prepaid USDC balance);
# it is carried in the request URL path, not a header. Text models only (no video).
# LLM_KEY_USEPOD=
```

(Leave it commented, matching how the other optional provider keys are presented.)

- [ ] **Step 3: Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS — typecheck clean; the full vitest suite green (including the new model/registry/redact tests); build (backend `tsc` + web SPA) succeeds. The web build needs no change — `usepod` surfaces in the dashboard picker automatically via `GET /api/models` iterating the registry's available providers.

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "docs(env): document LLM_KEY_USEPOD

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Manual smoke (optional, needs a real token)**

If a usepod token is available, set `LLM_KEY_USEPOD=<token>` and assign a datanet to `{ provider: 'usepod', model: 'deepseek-v3.2' }` in the dashboard; one vote cycle should score via usepod. A wrong model id fails at request time → recorded per-datanet skip (lazy validation, by design). Without a token, usepod simply does not appear in the picker and any usepod-configured datanet skips with "no API key for usepod".

---

## Self-Review

- **Spec coverage:** §Design 1 (union/enum/DEFAULT/KNOWN + resolveModel token-in-URL) → Tasks 1-2. §Design 2 (registry `LLM_KEY_USEPOD`) → Task 3. §Design 3 (redact `/proxy/<token>/`) → Task 4. §Design 4 (.env.example) → Task 5. Testing section (enum exhaustiveness, resolveModel base-URL, registry, redact, video-skip on non-google) → covered by Tasks 1-4; the Phase-A `resolveScoringModel` video-skip behavior needs no new code (usepod is non-`google`, so the existing `isVideo && provider!=='google'` skip already applies) — noted, no task required. ✓
- **Placeholder scan:** none — every step has verbatim code + exact commands + expected output. The base-URL test probe (Task 2 Step 1) names a concrete fallback (assert on whatever field the installed SDK exposes) rather than leaving it open. ✓
- **Type consistency:** `LlmProvider` union, `LlmProviderEnum`, `DEFAULT_MODEL`, `KNOWN_MODELS`, `ENV_BY_PROVIDER` all gain the SAME `usepod` key (the `Record<LlmProvider,…>` types enforce it — a missing one is a typecheck failure, surfaced in Tasks 1/3). `USEPOD_BASE_PREFIX` defined in Task 1, consumed in Task 2. Token-in-URL shape `https://api.usepod.ai/proxy/<token>/v1` is identical in resolveModel (Task 2), the redact rule (Task 4), and their tests. ✓
- **Ordering note:** typecheck is intentionally red between Task 1 (union grows → switch non-exhaustive, `ENV_BY_PROVIDER` incomplete) and Tasks 2-3 that complete the required entries; the full green gate is Task 5. This is called out in each task's expected output.
