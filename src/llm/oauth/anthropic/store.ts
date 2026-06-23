// src/llm/oauth/anthropic/store.ts — persist the Anthropic OAuth token set to the
// data volume. Same trust boundary as the budget ledger: a plaintext file in
// DATA_DIR, protected by 0600 perms (the wallet key already lives in .env). The
// token strings (`sk-ant-…`) are redacted by src/util/redact.ts if they ever reach
// a log line, so this module never logs them itself.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TokenSet } from './pkce.js'

const FILE = 'anthropic-oauth.json'

/** Absolute path of the credential file inside the data dir. */
export function oauthStorePath(dataDir: string): string {
  return join(dataDir, FILE)
}

function isTokenSet(v: unknown): v is TokenSet {
  const o = v as Record<string, unknown> | null
  return !!o &&
    typeof o.access_token === 'string' && o.access_token !== '' &&
    typeof o.refresh_token === 'string' && o.refresh_token !== '' &&
    typeof o.expires_at === 'number'
}

/** Load the persisted token set; null if absent, corrupt, or incomplete. */
export function loadTokenSet(dataDir: string): TokenSet | null {
  const path = oauthStorePath(dataDir)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return isTokenSet(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Persist the token set with owner-only (0600) perms. */
export function saveTokenSet(dataDir: string, tokens: TokenSet): void {
  writeFileSync(oauthStorePath(dataDir), JSON.stringify(tokens, null, 2), { mode: 0o600 })
}

/** True when a usable (non-corrupt) credential exists — drives provider availability. */
export function hasOAuthCredential(dataDir: string): boolean {
  return loadTokenSet(dataDir) !== null
}
