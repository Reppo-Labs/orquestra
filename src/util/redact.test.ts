import { describe, it, expect } from 'vitest'
import { redactSecrets } from './redact.js'

describe('redactSecrets', () => {
  it('redacts the rpc url value after --rpc-url (the alchemy key rides in the path)', () => {
    const s = 'Command failed: reppo vote --pod 922 --like --votes 8 --rpc-url https://base-mainnet.g.alchemy.com/v2/SECRETKEY123 — {"error":{"code":"X"}}'
    const out = redactSecrets(s)
    expect(out).not.toContain('SECRETKEY123')
    expect(out).toContain('--rpc-url <redacted>')
    expect(out).toContain('{"error":{"code":"X"}}') // error payload survives
  })

  it('redacts alchemy-style key paths even without the flag form', () => {
    // real alchemy keys are 32 chars; the /vN/ rule floors at 16 to avoid eating
    // short path words like /v2/docs.
    const out = redactSecrets('rpc error from https://base-mainnet.g.alchemy.com/v2/abcDEF123xyz4567890key: timeout')
    expect(out).not.toContain('abcDEF123xyz4567890key')
    expect(out).toContain('/v2/<redacted>')
  })

  it('redacts bearer tokens and inf_/acp_ prefixed api keys', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(redactSecrets('using key inf_a1b2c3d4e5')).toContain('inf_<redacted>')
    expect(redactSecrets('using key acp_a1b2c3d4e5')).toContain('acp_<redacted>')
  })

  it('redacts 64-hex private-key shapes', () => {
    const pk = '0x' + 'ab'.repeat(32)
    expect(redactSecrets(`oops ${pk} leaked`)).not.toContain(pk)
  })

  it('leaves ordinary content untouched (tx hashes are 32-byte but legitimate output)', () => {
    // tx hashes are also 0x + 64 hex — they MUST survive (forensics) when labeled as such
    const s = 'txHash: 0x' + 'cd'.repeat(32)
    expect(redactSecrets(s)).toBe(s)
    expect(redactSecrets('plain error, nothing secret; pod 925')).toBe('plain error, nothing secret; pod 925')
  })
})
