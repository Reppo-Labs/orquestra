// src/llm/oauth/anthropic/pkce.ts — OAuth 2.0 PKCE mechanics for the Anthropic
// subscription provider (`anthropic-oauth`). Pure except for the network call,
// which is injected so the flow is unit-tested without hitting Anthropic.
//
// These client params are reverse-engineered public values shared by community
// tools; Anthropic may rotate them, in which case calls fail at request time
// (same failure class as a renamed model slug). See the design doc:
// docs/superpowers/specs/2026-06-23-anthropic-oauth-provider-design.md
import { createHash, randomBytes } from 'node:crypto'

/** Public OAuth client id used by Claude's first-party clients. */
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
/** Subscription (Pro/Max) authorize endpoint. */
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
/** Token endpoint (auth-code exchange + refresh). */
export const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
/** Hosted callback that renders the `code#state` the operator pastes back. */
export const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
/** Scopes; `user:inference` is the one that authorizes Messages API calls. */
export const SCOPES = 'org:create_api_key user:profile user:inference'

/** Persisted credential. `expires_at` is an absolute ms-epoch deadline (not a
 *  TTL) so freshness checks need no record of when the token was minted. */
export interface TokenSet {
  access_token: string
  refresh_token: string
  expires_at: number
}

export interface Pkce {
  verifier: string
  challenge: string
  state: string
}

interface NetDeps {
  fetch?: typeof fetch
  now?: () => number
}

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Fresh PKCE verifier/challenge + a CSRF state, all base64url. */
export function generatePkce(): Pkce {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))
  return { verifier, challenge, state }
}

/** Build the browser authorize URL the operator opens to grant access. */
export function buildAuthorizeUrl({ challenge, state }: { challenge: string; state: string }): string {
  const u = new URL(AUTHORIZE_URL)
  u.searchParams.set('code', 'true')
  u.searchParams.set('client_id', CLIENT_ID)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('redirect_uri', REDIRECT_URI)
  u.searchParams.set('scope', SCOPES)
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', state)
  return u.toString()
}

async function postToken(body: Record<string, string>, deps: NetDeps): Promise<TokenSet> {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`anthropic oauth token endpoint ${res.status}: ${detail.slice(0, 200)}`)
  }
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
  // Validate the fields we depend on. A missing access_token is unusable; a missing/non-finite
  // expires_in would make expires_at NaN → fresh() always false → a refresh on EVERY request
  // (token-endpoint hot loop). Fail the exchange/refresh loudly instead.
  if (typeof j.access_token !== 'string' || j.access_token === '') {
    throw new Error('anthropic oauth: token response missing access_token')
  }
  if (typeof j.expires_in !== 'number' || !Number.isFinite(j.expires_in)) {
    throw new Error('anthropic oauth: token response missing a numeric expires_in')
  }
  return {
    access_token: j.access_token,
    // a refresh may return no new refresh_token — keep the one we sent.
    refresh_token: j.refresh_token ?? body.refresh_token ?? '',
    expires_at: now() + j.expires_in * 1000,
  }
}

/** Exchange the pasted `code#state` for a token set (one-time, at login). When
 *  `expectedState` is given, the state echoed back in the paste must equal it — a CSRF
 *  guard so a code from an attacker-initiated authorize flow is rejected before exchange. */
export async function exchangeCode(
  { codeAndState, verifier, expectedState }: { codeAndState: string; verifier: string; expectedState?: string },
  deps: NetDeps = {},
): Promise<TokenSet> {
  const [code, state = ''] = codeAndState.trim().split('#')
  if (expectedState !== undefined && state !== expectedState) {
    throw new Error('anthropic oauth: state mismatch — the pasted code is not from this login (possible CSRF); aborting')
  }
  return postToken(
    {
      grant_type: 'authorization_code',
      code,
      state,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    },
    deps,
  )
}

/** Exchange a refresh_token for a fresh token set (headless, per-expiry). */
export function refresh(refreshToken: string, deps: NetDeps = {}): Promise<TokenSet> {
  return postToken(
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
    deps,
  )
}
