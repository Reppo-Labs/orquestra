# Dashboard-selectable node default model — design

**Date:** 2026-06-17
**Status:** Approved (design); implementation pending
**Author:** Ana (with Claude Code)
**Repo:** orquestra

## Problem

The node's **default LLM model** (provider + slug) is set only via env
(`LLM_PROVIDER` + the key registry) and built **once at startup**. The operator
can pick a model **per datanet** in the dashboard (shipped), but cannot change the
**node default** without editing env + restarting. This bit us live: the default
provider `virtuals` ran out of credits, so the Assistant chat (and onboarding,
mint scoring, panel, learn, and every datanet without a per-datanet override)
failed with `Payment Required` (HTTP 402) — with no dashboard way to switch to the
funded `usepod` provider.

Goal: let the operator choose the node default `{provider, model}` from the
dashboard, taking effect without a restart. Keys stay env-only (ADR 0002).

## Current wiring (verified)

- `src/index.ts:132-142`: builds `providerKeyRegistry` from env, picks
  `provider = process.env.LLM_PROVIDER ?? 'anthropic'`, `defaultKey =
  registry.get(provider)`, `defaultModel = DEFAULT_MODEL[provider]`,
  `model = resolveModel(provider, defaultKey, defaultModel)`. That `model` is
  injected into the dashboard as `chatModel` (used by the Assistant + onboarding
  chat) and threaded into the cycle as `defaultProvider`/`defaultModel`.
- The cycle's default is consumed via `resolveScoringModel` for any datanet
  without a per-datanet `model`; config is **hot-reloaded** each cycle.
- `src/dashboard/server.ts`: the Assistant chat (`/api/strategy/chat` →
  `runStrategyChat({ model: opts.chatModel })`) and onboarding
  (`defaultOnboardingTurn(opts.chatModel)`) use the **once-built** `chatModel`.
- `GET /api/models` already returns `{ providers: [{ provider, hasKey, models }] }`
  for providers WITH a key — names only, never keys.

## Decisions (settled during brainstorming)

1. **Config overrides env; env is the bootstrap + key source.** A new optional
   `config.defaultModel` is the node default when set; otherwise the env
   `LLM_PROVIDER` default (today's behavior). Env still supplies all KEYS.
2. **Hot-reloaded, no restart** — a dashboard change takes effect next cycle
   (scoring) and next chat request (assistant/onboarding).
3. **Keyless default → fall back to env default + record why.** If
   `config.defaultModel`'s provider has no key in the registry, ignore it, use the
   env default, and record a visible reason. A bad dashboard pick never bricks
   scoring or chat.
4. **Keys stay env-only** — the picker lists only providers with a key; no key
   entry in the dashboard.

## Design

### 1. Config (`src/config/schema.ts`)
Add a top-level optional field (same shape as the per-datanet `model`):
```ts
defaultModel: z.object({ provider: LlmProviderEnum, model: z.string().min(1) }).optional()
```
Persisted; hot-reloaded by the existing `reloadConfig` path.

### 2. `effectiveDefault` resolver (`src/llm/`)
A single pure helper used by BOTH consumers:
```ts
effectiveDefault(args: {
  configDefault?: { provider: LlmProvider; model: string }
  registry: Map<LlmProvider, string>
  envProvider: LlmProvider
  envModel: string
}): { provider: LlmProvider; model: string; key: string; usedFallback?: string }
```
- If `configDefault` set AND `registry.get(configDefault.provider)` is non-empty →
  use `{ configDefault.provider, configDefault.model, key }`.
- Else if `configDefault` set but its provider has NO key → use the env default and
  set `usedFallback = "default provider <p> has no API key; using env default"`.
- Else (no `configDefault`) → env default (`envProvider`/`envModel`/its key).

### 3. Cycle scoring (`src/runtime/wiring.ts`, `src/index.ts`)
The cycle already hot-reloads config. Compute `defaultProvider`/`defaultModel`
(and key) from `effectiveDefault(configDefault = config.defaultModel, …)` so a
datanet without a per-datanet override scores on the chosen node default. Record
the `usedFallback` reason (if any) once per reload.

### 4. Assistant + onboarding chat (`src/index.ts`, `src/dashboard/server.ts`)
The load-bearing change: replace the once-built `chatModel: LanguageModel`
injected at dashboard construction with a **thunk** `resolveChatModel(): LanguageModel | null`
that calls `effectiveDefault` against the **current** config + registry each call.
- `/api/strategy/chat` and the onboarding turn call `resolveChatModel()` per
  request; a `null` (no key for the effective default at all) returns the existing
  503 "chat unavailable" path.
- This makes a dashboard default-change take effect on the next chat message — no
  restart — which is what fixes the live 402.

### 5. Dashboard (`web/src/components/StrategyTab.tsx`, `web/src/api.ts`)
- A **node-level** provider+model picker at the top of the Strategy tab (above the
  per-datanet list), populated from `GET /api/models` (providers with keys only).
  Writes `config.defaultModel`. Free-text model slug allowed (slugs drift), like
  the per-datanet picker. No key field.
- `api.ts`: extend the config type with `defaultModel?`.

### 6. Security
Keys env-only, never persisted to config / returned by an endpoint / logged
(`redactSecrets`). The picker exposes provider + model NAMES + `hasKey` only.

## Testing
- schema: `defaultModel` parses; rejects an unknown provider; absent is valid.
- `effectiveDefault`: config override used when its provider is keyed; falls back
  to env (with a reason) when the configured provider is keyless; env default when
  `configDefault` absent.
- chat: `resolveChatModel()` re-resolves from CURRENT config — a config change
  yields a model built from the new provider/model (no restart); returns null →
  503 when the effective default has no key at all.
- cycle: a datanet with no per-datanet `model` scores on `config.defaultModel` when
  set; on the env default when unset.
- web: the node-default picker reads `/api/models` and writes `config.defaultModel`;
  shows a persisted value whose provider lost its key (mirrors the per-datanet
  stale-override handling).

## Open assumptions
- The Assistant/onboarding chat tolerates being re-resolved per request (cheap —
  `resolveModel` is config-binding only, no network until the request fires).
- A fresh node (no config yet) keeps using the env default for onboarding — the
  config (and thus `defaultModel`) does not exist until onboarding completes;
  chicken-and-egg is handled by the env bootstrap path.

## Out of scope
- Entering API keys in the dashboard (env-only; ADR 0002).
- Per-request model selection for the cycle (already per-datanet).
- Changing the env bootstrap mechanism or the key registry.
- A live fetch of each provider's `/v1/models` catalog (free-text covers it).
