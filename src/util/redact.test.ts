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

  it('redacts keyed provider URLs outside the flag form: alchemy, infura, quiknode', () => {
    const al = redactSecrets('rpc error from https://base-mainnet.g.alchemy.com/v2/abcDEF123xyz4567890key: timeout')
    expect(al).not.toContain('abcDEF123xyz4567890key')
    expect(al).toContain('/v2/<redacted>')
    const inf = redactSecrets('failed to connect to https://mainnet.infura.io/v3/SECRETKEY1234567890: timeout')
    expect(inf).not.toContain('SECRETKEY1234567890')
    const qn = redactSecrets('rpc https://billowing-old-pine.quiknode.pro/abc123def456 failed')
    expect(qn).not.toContain('abc123def456')
  })

  it('does NOT mangle generic REST paths (review finding: over-redaction)', () => {
    expect(redactSecrets('GET https://api.example.com/v1/transactions_endpoint_data failed'))
      .toContain('transactions_endpoint_data')
    expect(redactSecrets('calling /v2/getLogsByBlockRange now')).toContain('getLogsByBlockRange')
  })

  it('preserves tx hashes and signatures in ALL forms (review finding: false redaction)', () => {
    const h = '0x' + 'ab'.repeat(32)
    expect(redactSecrets(`{"txHash":"${h}"}`)).toContain(h)
    expect(redactSecrets(`https://basescan.org/tx/${h}`)).toContain(h)
    expect(redactSecrets(`Vote tx reverted: ${h}`)).toContain(h)
    expect(redactSecrets(`nextTxParam ${h}`)).toContain(h) // no false "tx"-substring redaction
    const sig = '0x' + 'ef'.repeat(65) // 130-hex signature (public, not secret)
    expect(redactSecrets(`sig ${sig}`)).toContain(sig)
  })

  it('redacts bearer tokens and inf_/acp_ prefixed api keys', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(redactSecrets('using key inf_a1b2c3d4e5f6g7')).toContain('inf_<redacted>')
    expect(redactSecrets('using key acp_a1b2c3d4e5f6g7')).toContain('acp_<redacted>')
  })

  it('redacts credential-in-URL shapes for ANY host (review finding)', () => {
    const ba = redactSecrets('request to https://user:s3cr3tpass@my-node.example/ failed')
    expect(ba).not.toContain('s3cr3tpass')
    expect(ba).toContain('user:<redacted>@')
    const qs = redactSecrets('rpc https://rpc.llamarpc.com/?apikey=SUPERSECRET123 failed')
    expect(qs).not.toContain('SUPERSECRET123')
    expect(qs).toContain('apikey=<redacted>')
  })

  it('redacts a URL-encoded / padded provider key in full, not just the leading chars', () => {
    const out = redactSecrets('https://base-mainnet.g.alchemy.com/v2/SECRET%2DKEY.pad=123')
    expect(out).not.toContain('SECRET')
    expect(out).not.toContain('%2DKEY')
    expect(out).toContain('/v2/<redacted>')
  })

  it('does not mangle short prose starting with inf_/acp_', () => {
    expect(redactSecrets('inf_short')).toBe('inf_short') // below the 12-char key floor
  })

  it('leaves ordinary content untouched', () => {
    expect(redactSecrets('plain error, nothing secret; pod 925')).toBe('plain error, nothing secret; pod 925')
  })
})
