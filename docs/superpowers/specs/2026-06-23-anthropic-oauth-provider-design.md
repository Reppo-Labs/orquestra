# Anthropic subscription OAuth provider (`anthropic-oauth`)

**Date:** 2026-06-23
**Status:** shipped (PR #89) — but the **token-minting approach below is SUPERSEDED**.

> **Superseded:** the hand-rolled PKCE login described in this doc does NOT work —
> Anthropic rejects the OAuth authorize flow from third-party clients ("Invalid request
> format") and is phasing out third-party OAuth. The shipped implementation instead mints
> the token via the first-party `claude setup-token` CLI (see `src/llm/oauth/anthropic/
> setupToken.ts`), stores `{ access_token }` (long-lived, no refresh), and injects the
> required Claude Code system block on every request (`makeOAuthFetch` in `model.ts`).
> Operator steps: **docs/operator-guide.md §3a-bis**. The provider wiring, registry sentinel,
> resolver seam, and consumption (Bearer + oauth beta) below are accurate as shipped.

## Goal

Let an operator drive the node's LLM inference through their Claude
subscription (Pro/Max) via OAuth, instead of a metered Anthropic API key. Adds
a new provider `anthropic-oauth` alongside the existing key-auth providers.

## Decisions (locked during brainstorming)

- **Token source:** build our own PKCE login (no Claude Code credential
  piggyback, no out-of-band paste).
- **Provider identity:** a distinct `anthropic-oauth` value in
  `LlmProviderEnum` — usable side by side with key-auth `anthropic`.
- **Login redirect:** manual `code#state` paste (no localhost listener) —
  SSH/container friendly.

## Risk notes (accepted)

- **ToS:** programmatic use of a consumer Claude subscription violates
  Anthropic's terms; seat-ban risk. Accepted by the operator.
- **Param drift:** `client_id`, scopes, and the `anthropic-beta` header are
  reverse-engineered public values. If Anthropic rotates them, calls fail at
  request time (same failure class as the existing model-slug drift).

## Public OAuth parameters

- client_id: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- authorize: `https://claude.ai/oauth/authorize`
- token: `https://console.anthropic.com/v1/oauth/token`
- redirect: `https://console.anthropic.com/oauth/code/callback` (hosted; shows
  the `code#state` the operator pastes)
- scopes: `org:create_api_key user:profile user:inference`
- inference headers: `Authorization: Bearer <access_token>`,
  `anthropic-beta: oauth-2025-04-20`, and **no** `x-api-key`

## Architecture

### `src/llm/oauth/anthropic/`

- **`pkce.ts`** — pure mechanics, `fetch` injectable for tests:
  - `generatePkce(): { verifier, challenge }` — S256 via `node:crypto`
  - `buildAuthorizeUrl(challenge): string`
  - `exchangeCode(codeAndState, verifier, fetch?): Promise<TokenSet>`
  - `refresh(refreshToken, fetch?): Promise<TokenSet>`
  - `TokenSet = { access_token, refresh_token, expires_at }` (expires_at = ms epoch)
- **`store.ts`** — load/save `TokenSet` to `DATA_DIR/anthropic-oauth.json`
  (0600 perms; corrupt-file handling; never logged — runs through redact).
- **`tokenManager.ts`** — `getAccessToken(): Promise<string>`. Returns the
  cached access token; if expired or within a refresh skew window, calls
  `refresh()`, **re-persists the rotated refresh_token**, returns the fresh
  access token. Single source of token truth.

### Login subcommand

`orquestra login-anthropic` (new argv branch in `index.ts`, beside `configure`):

1. `generatePkce()`, print `buildAuthorizeUrl(challenge)` via the terminal prompter.
2. Operator logs in, copies the `code#state`, pastes at the prompt.
3. `exchangeCode()` → `store.save()`.
4. Print success. Re-runnable (overwrites the stored token set).

### Provider wiring (`src/llm/model.ts`)

- Add `'anthropic-oauth'` to the `LlmProvider` union, `LlmProviderEnum`,
  `DEFAULT_MODEL` (`claude-opus-4-7`), and `KNOWN_MODELS`.
- Extend `resolveModel(provider, apiKey, model?, opts?)` with an optional 4th
  arg `{ tokenProvider?: () => Promise<string> }` (backward compatible).
  For `anthropic-oauth`: `createAnthropic({ apiKey: '', fetch: oauthFetch })`,
  where `oauthFetch` deletes `x-api-key`, sets `Authorization: Bearer <await
  tokenProvider()>`, and adds `anthropic-beta: oauth-2025-04-20`.
  **Token is fetched per request** so an 8h access-token expiry never produces a
  stale resolved model in the long-running daemon.

### Availability

`anthropic-oauth` is not env-keyed. `buildProviderKeyRegistry` stays env-only.
Availability = the store file exists in `DATA_DIR`; merged into
`availableProviders` separately.

### Token-provider injection

`index.ts` constructs the `tokenManager` from `DATA_DIR` and threads its
`getAccessToken` into the model-resolution seam (`ModelResolver` in
`resolveScoringModel.ts`). A composed resolver special-cases `anthropic-oauth`
and delegates the other providers to `resolveModel` unchanged.

## Tests

- `pkce.test.ts` — verifier/challenge shape; authorize URL params;
  exchange/refresh with mocked fetch + fixtures.
- `store.test.ts` — round-trip; perms; corrupt-file handling.
- `tokenManager.test.ts` — fresh passthrough; expired → refresh → re-persist;
  rotated refresh_token saved.
- `model.test.ts` — oauth branch: `x-api-key` stripped, Bearer + beta set,
  `tokenProvider` awaited per call.

## Out of scope (YAGNI)

Loopback redirect server; Claude Code credential reuse; daemon auto-login
(login is a deliberate one-time interactive step); token encryption at rest
(DATA_DIR already holds the budget ledger — same trust boundary; file perms only).
