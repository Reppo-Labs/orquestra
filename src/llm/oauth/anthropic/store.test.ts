import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCredential, saveCredential, hasOAuthCredential, oauthStorePath } from './store.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oauth-store-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const CRED = { access_token: 'sk-ant-oat01-ABC123' }

describe('saveCredential / loadCredential', () => {
  it('round-trips a credential', () => {
    saveCredential(dir, CRED)
    expect(loadCredential(dir)).toEqual(CRED)
  })

  it('keeps only access_token (drops any extra persisted fields)', () => {
    writeFileSync(oauthStorePath(dir), JSON.stringify({ access_token: 'sk-ant-oat01-X', stale: 1 }))
    expect(loadCredential(dir)).toEqual({ access_token: 'sk-ant-oat01-X' })
  })

  it('writes the file 0600 (owner read/write only)', () => {
    saveCredential(dir, CRED)
    expect(statSync(oauthStorePath(dir)).mode & 0o777).toBe(0o600)
  })

  it('returns null when no credential file exists', () => {
    expect(loadCredential(dir)).toBeNull()
  })

  it('returns null on a corrupt (non-JSON) file', () => {
    writeFileSync(oauthStorePath(dir), 'not json{')
    expect(loadCredential(dir)).toBeNull()
  })

  it('returns null when access_token is missing/blank', () => {
    writeFileSync(oauthStorePath(dir), JSON.stringify({ access_token: '' }))
    expect(loadCredential(dir)).toBeNull()
  })
})

describe('hasOAuthCredential', () => {
  it('is false before login and true after a saved credential', () => {
    expect(hasOAuthCredential(dir)).toBe(false)
    saveCredential(dir, CRED)
    expect(hasOAuthCredential(dir)).toBe(true)
  })

  it('is false when the file exists but is corrupt', () => {
    writeFileSync(oauthStorePath(dir), '{')
    expect(hasOAuthCredential(dir)).toBe(false)
  })
})
