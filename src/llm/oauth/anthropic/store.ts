// src/llm/oauth/anthropic/store.ts — persist the Anthropic subscription OAuth token to the
// data volume. The token is minted by the first-party `claude setup-token` CLI (see
// setupToken.ts) and is long-lived, so we store just the token — no refresh_token/expiry.
// Same trust boundary as the budget ledger: a plaintext file in DATA_DIR, 0600 perms (the
// wallet key already lives in .env). The token (`sk-ant-oat…`) is redacted by
// src/util/redact.ts if it ever reaches a log line, so this module never logs it.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** The persisted credential: a long-lived `sk-ant-oat…` subscription token. */
export interface OAuthCredential {
  access_token: string
}

const FILE = 'anthropic-oauth.json'

/** Absolute path of the credential file inside the data dir. */
export function oauthStorePath(dataDir: string): string {
  return join(dataDir, FILE)
}

function isCredential(v: unknown): v is OAuthCredential {
  const o = v as Record<string, unknown> | null
  return !!o && typeof o.access_token === 'string' && o.access_token !== ''
}

/** Load the persisted credential; null if absent, corrupt, or incomplete. */
export function loadCredential(dataDir: string): OAuthCredential | null {
  const path = oauthStorePath(dataDir)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return isCredential(parsed) ? { access_token: parsed.access_token } : null
  } catch {
    return null
  }
}

/** Persist the credential with owner-only (0600) perms. Atomic: write a temp file then
 *  rename over the target, so a crash / kill / ENOSPC mid-write can't leave a torn JSON
 *  (which loadCredential would read as "no credential", silently dropping the subscription). */
export function saveCredential(dataDir: string, cred: OAuthCredential): void {
  const path = oauthStorePath(dataDir)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}

/** True when a usable (non-corrupt) credential exists — drives provider availability. */
export function hasOAuthCredential(dataDir: string): boolean {
  return loadCredential(dataDir) !== null
}
