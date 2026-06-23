// src/llm/oauth/anthropic/tokenManager.ts — supplies the current subscription access token to
// makeOAuthFetch. The token from `claude setup-token` is long-lived (no refresh flow), so this
// just reads the stored credential. It re-reads on every call (cheap) so a fresh
// `login-anthropic` is picked up without a restart, and a revoked token surfaces a clear error.
import type { OAuthCredential } from './store.js'

export interface TokenManagerDeps {
  /** Load the persisted credential (store.loadCredential bound to the data dir). */
  load: () => OAuthCredential | null
}

export interface TokenManager {
  /** The current access token, or throws if the operator has not logged in. */
  getAccessToken: () => Promise<string>
}

export function createTokenManager(deps: TokenManagerDeps): TokenManager {
  return {
    async getAccessToken(): Promise<string> {
      const cred = deps.load()
      if (!cred) {
        throw new Error('no Anthropic OAuth credential — run `orquestra login-anthropic` first')
      }
      return cred.access_token
    },
  }
}
