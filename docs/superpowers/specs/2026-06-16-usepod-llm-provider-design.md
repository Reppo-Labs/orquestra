# Add `usepod` LLM provider — design

**Date:** 2026-06-16
**Status:** Approved (design); implementation pending
**Author:** Ana (with Claude Code)
**Repo:** orquestra

## Problem

Add [usepod.ai](https://usepod.ai/) as a selectable LLM provider so an operator can
route a datanet's scoring to usepod's models. usepod is a decentralized,
OpenAI-compatible inference marketplace (open-weight models — Llama 4, Qwen 3.5,
DeepSeek, Mistral, GLM — served by independent hosts, addressed by canonical model
id). It slots into the existing per-datanet model-selection mechanism (Phase A,
already shipped) alongside `virtuals`/`surplus`.

## Integration surface (verified against docs.usepod.ai)

- **OpenAI-compatible**, drop-in. The docs' quickstart shows:
  ```python
  client = OpenAI(base_url="https://api.usepod.ai/proxy/<token>/v1", api_key="unused")
  ```
- **Auth is a token in the URL PATH, not a bearer header.** Base URL =
  `https://api.usepod.ai/proxy/<token>/v1`; the `Authorization` header / `api_key`
  is ignored (`"unused"`). The token is obtained once via `POST
  https://api.usepod.ai/register`, which returns the token + a USDC deposit address
  (prepaid balance; each response carries an `X-Balance-Remaining` header).
- **Model ids are canonical and host-advertised.** Per `docs.usepod.ai/llms-full.txt`,
  matching strips vendor prefixes (`deepseek/deepseek-v4` ≡ `deepseek-v4`). The live
  catalog is a marketplace (hosts join/leave) and is token/account-specific — there is
  no fixed list to hardcode authoritatively.
- **No native video** (open-weight text models). usepod is a text/scoring provider;
  the video path stays `google`-only.

This is the same shape as `virtuals`/`surplus` (`createOpenAI({ apiKey, baseURL })`),
with two real differences: the **token lives in the base URL** (not the header), and
that URL **must be redacted** wherever it can surface.

## Decisions (settled during brainstorming)

1. **Drop-in provider only** — the prepaid-token path. NOT the wallet-native
   x402/Solana per-call settlement (that needs a separate Solana key + signing
   client; explicitly out of scope).
2. **Token-in-URL** — `resolveModel` builds the base URL from the configured key;
   `apiKey: 'unused'` for the OpenAI client.
3. **Free-text model ids** — the dashboard model field already allows free text
   (slugs drift, validated lazily at request time). Seed convenience hints only.
4. **Not the node default** — usepod is opt-in per datanet; the node default
   provider/model is unchanged.
5. **Secret-in-URL redaction is load-bearing** — the `/proxy/<token>/` segment is
   redacted before any logging/activity persistence (unauthenticated dashboard).

## Design

### 1. Provider wiring (`src/llm/model.ts`)
- Add `'usepod'` to the `LlmProvider` union (line 8) and `LlmProviderEnum` (line 39).
- `DEFAULT_MODEL.usepod` + `KNOWN_MODELS.usepod`: seed canonical-id hints from
  usepod's published model lineup — `deepseek-v3.2`, `qwen-3.5`, `llama-4`,
  `mistral`, `glm-5.1` — with `deepseek-v3.2` as the default. These are picker hints
  only; operators set the exact id per datanet. (Open assumption — see below.)
- `resolveModel` gets a `case 'usepod'`. The token-in-URL twist:
  ```ts
  case 'usepod':
    // OpenAI-compatible, but the token is in the URL PATH (api_key unused).
    return createOpenAI({
      apiKey: 'unused',
      baseURL: `${USEPOD_BASE_PREFIX}/${apiKey}/v1`,
    })(model ?? DEFAULT_MODEL.usepod)
  ```
  with `const USEPOD_BASE_PREFIX = 'https://api.usepod.ai/proxy'` (a prefix, since
  the per-call token is interpolated — unlike the static `VIRTUALS_BASE_URL`/
  `SURPLUS_BASE_URL` constants).

### 2. Key registry (`src/llm/registry.ts`)
Add `usepod: 'LLM_KEY_USEPOD'` to `ENV_BY_PROVIDER` (line 9-15). The
`Record<LlmProvider, string>` type **forces** this entry once the union grows, so it
cannot be forgotten. The operator's `LLM_KEY_USEPOD` value is the usepod **token**
(it ends up in the base URL). usepod then auto-appears in the dashboard picker —
`GET /api/models` and `StrategyTab` iterate `availableProviders`, so **no web change
is needed**.

### 3. Secret redaction (`src/util/redact.ts`)
The usepod token is part of a URL that can appear in AI-SDK error messages → the
activity log → the unauthenticated dashboard. Add a pattern that redacts the token
path segment:
```ts
// usepod proxy token lives in the URL path: https://api.usepod.ai/proxy/<token>/v1
s = s.replace(/(api\.usepod\.ai\/proxy\/)[^/\s"']+/gi, '$1<redacted>')
```
(The existing rules cover `?key=` query params + `Bearer ` + `inf_`/`acp_` + LLM key
shapes, none of which match a path segment.)

### 4. Docs (`.env.example`)
Document `LLM_KEY_USEPOD` next to the other `LLM_KEY_*` vars: the drop-in token from
`POST https://api.usepod.ai/register` (prepaid USDC balance; OpenAI-compatible;
text models only).

## Testing
- `model.test.ts`: `LlmProviderEnum` ↔ union exhaustiveness still holds with `usepod`
  added; `resolveModel('usepod', '<tok>', 'deepseek-v3.2')` returns a model whose
  client base URL is `https://api.usepod.ai/proxy/<tok>/v1` and whose key is unused
  (assert via the injected-resolver / client-shape pattern already used for the other
  gateways); `KNOWN_MODELS.usepod` contains `DEFAULT_MODEL.usepod`.
- `registry.test.ts`: `LLM_KEY_USEPOD=<tok>` → registry has `usepod`; back-compat
  default path unaffected.
- `redact.test.ts`: `https://api.usepod.ai/proxy/SECRETTOKEN/v1` → the token is
  replaced with `<redacted>`; a non-usepod URL is untouched.
- `resolveScoringModel` (Phase A): a datanet with `model:{provider:'usepod',...}` and
  a usepod key resolves (text path); a **video** pod on a usepod datanet still skips
  ("video pod needs a Gemini model") — usepod is non-`google`.

## Open assumption (confirm)
**Exact model slugs.** usepod's public docs show only a placeholder (`gpt-5.5`); the
marketplace catalog is a JS SPA / token-gated `/v1/models` I couldn't enumerate
non-interactively. The seeded `KNOWN_MODELS.usepod` ids (`deepseek-v3.2`, `qwen-3.5`,
`llama-4`, `mistral`, `glm-5.1`) and the `deepseek-v3.2` default are best-effort
canonical ids from usepod's homepage lineup; operators override per datanet
(free-text, lazily validated). Confirm or adjust the default once a real token can
hit `GET https://api.usepod.ai/proxy/<token>/v1/models`.

## Out of scope
- The wallet-native x402 / Solana per-call settlement path (needs a separate Solana
  key + signing client).
- Making usepod the node default provider.
- Native video via usepod (text models only; video stays `google`).
- A live dashboard fetch of usepod's `/v1/models` catalog (free-text covers it;
  could be a later enhancement).
