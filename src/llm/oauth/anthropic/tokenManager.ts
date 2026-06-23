// src/llm/oauth/anthropic/tokenManager.ts — single source of access-token truth for
// the long-running daemon. The access token expires (~8h); this refreshes it on
// demand, re-persisting the rotated refresh_token. Dependencies (load/save/refresh)
// are injected so the policy is unit-tested without fs or network.
import type { TokenSet } from './pkce.js'

/** Refresh once the token is within this window of (or past) its hard expiry. */
const DEFAULT_SKEW_MS = 60_000

export interface TokenManagerDeps {
  /** Load the persisted token set (store.loadTokenSet bound to the data dir). */
  load: () => TokenSet | null
  /** Persist a rotated token set (store.saveTokenSet bound to the data dir). */
  save: (t: TokenSet) => void
  /** Exchange a refresh_token for a fresh set (pkce.refresh). */
  refresh: (refreshToken: string) => Promise<TokenSet>
  now?: () => number
  skewMs?: number
}

export interface TokenManager {
  /** A valid access token, refreshing + re-persisting if the current one is stale. */
  getAccessToken: () => Promise<string>
}

export function createTokenManager(deps: TokenManagerDeps): TokenManager {
  const now = deps.now ?? Date.now
  const skew = deps.skewMs ?? DEFAULT_SKEW_MS
  // In-memory cache so steady-state calls touch neither disk nor network. Seeded
  // lazily from the store on first use.
  let current: TokenSet | null = null
  // Shared in-flight refresh so concurrent expired calls trigger one token call.
  let inflight: Promise<TokenSet> | null = null

  const fresh = (t: TokenSet): boolean => now() < t.expires_at - skew

  async function getAccessToken(): Promise<string> {
    if (!current) current = deps.load()
    if (!current) {
      throw new Error('no Anthropic OAuth credential — run `orquestra login-anthropic` first')
    }
    if (fresh(current)) return current.access_token

    if (!inflight) {
      const refreshToken = current.refresh_token
      inflight = deps.refresh(refreshToken).then((next) => {
        deps.save(next)
        current = next
        return next
      }).catch((e) => {
        // Drop the cached set on failure so the NEXT call re-reads disk — picks up an operator
        // re-login (fresh file) and stops looping a revoked refresh_token held only in memory.
        current = null
        throw e
      }).finally(() => { inflight = null })
    }
    const refreshed = await inflight
    return refreshed.access_token
  }

  return { getAccessToken }
}
