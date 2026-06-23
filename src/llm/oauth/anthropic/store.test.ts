import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTokenSet, saveTokenSet, hasOAuthCredential, oauthStorePath } from './store.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oauth-store-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const TOKENS = { access_token: 'sk-ant-oat01-A', refresh_token: 'sk-ant-ort01-R', expires_at: 1_700_000_000_000 }

describe('saveTokenSet / loadTokenSet', () => {
  it('round-trips a token set', () => {
    saveTokenSet(dir, TOKENS)
    expect(loadTokenSet(dir)).toEqual(TOKENS)
  })

  it('writes the file 0600 (owner read/write only)', () => {
    saveTokenSet(dir, TOKENS)
    expect(statSync(oauthStorePath(dir)).mode & 0o777).toBe(0o600)
  })

  it('returns null when no credential file exists', () => {
    expect(loadTokenSet(dir)).toBeNull()
  })

  it('returns null on a corrupt (non-JSON) file', () => {
    writeFileSync(oauthStorePath(dir), 'not json{')
    expect(loadTokenSet(dir)).toBeNull()
  })

  it('returns null when required fields are missing', () => {
    writeFileSync(oauthStorePath(dir), JSON.stringify({ access_token: 'A' }))
    expect(loadTokenSet(dir)).toBeNull()
  })
})

describe('hasOAuthCredential', () => {
  it('is false before login and true after a saved token set', () => {
    expect(hasOAuthCredential(dir)).toBe(false)
    saveTokenSet(dir, TOKENS)
    expect(hasOAuthCredential(dir)).toBe(true)
  })

  it('is false when the file exists but is corrupt', () => {
    writeFileSync(oauthStorePath(dir), '{')
    expect(hasOAuthCredential(dir)).toBe(false)
  })
})
