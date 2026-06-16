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
    // hyphen-separated Virtuals key (provider docs use `acp-`) must also be redacted
    const hyphen = redactSecrets('using key acp-a1b2c3d4e5f6g7')
    expect(hyphen).not.toContain('a1b2c3d4e5f6g7')
    expect(hyphen).toContain('acp-<redacted>')
  })

  it('redacts credential-in-URL shapes for ANY host (review finding)', () => {
    const ba = redactSecrets('request to https://user:s3cr3tpass@my-node.example/ failed')
    expect(ba).not.toContain('s3cr3tpass')
    expect(ba).toContain('user:<redacted>@')
    const qs = redactSecrets('rpc https://rpc.llamarpc.com/?apikey=SUPERSECRET123 failed')
    expect(qs).not.toContain('SUPERSECRET123')
    expect(qs).toContain('apikey=<redacted>')
  })

  it('basic-auth: spans an embedded @ in the password and tolerates an empty username (review findings)', () => {
    const at = redactSecrets('https://admin:p@ssword@host/ failed')
    expect(at).not.toContain('p@ssword')
    expect(at).toContain('@host/')
    const empty = redactSecrets('https://:s3cr3t@host/ failed')
    expect(empty).not.toContain('s3cr3t')
  })

  it('basic-auth regex does NOT mis-fire on a host:port URL with an @ in the path', () => {
    const s = 'GET https://rpc.host:8545/path@v2 returned 500'
    expect(redactSecrets(s)).toBe(s) // no credentials → untouched
  })

  it('provider-key redaction stops at a trailing period, not eating prose', () => {
    const out = redactSecrets('see https://base-mainnet.g.alchemy.com/v2/MYKEYHERE123456.')
    expect(out).not.toContain('MYKEYHERE123456')
    expect(out).toContain('/v2/<redacted>.') // sentence period preserved
  })

  it('redacts a percent-encoded provider key', () => {
    const out = redactSecrets('https://base-mainnet.g.alchemy.com/v2/SECRET%2DKEY12345 failed')
    expect(out).not.toContain('SECRET%2DKEY12345')
    expect(out).toContain('/v2/<redacted>')
  })

  it('does not mangle short prose starting with inf_/acp_', () => {
    expect(redactSecrets('inf_short')).toBe('inf_short') // below the 12-char key floor
  })

  it('redacts Anthropic sk-ant-… keys', () => {
    const k = 'sk-ant-api03-' + 'A1b2C3d4'.repeat(12)
    const out = redactSecrets(`Authorization: ${k}`)
    expect(out).not.toContain(k)
    expect(out).toContain('sk-ant-<redacted>')
  })

  it('redacts bare OpenAI sk-… keys (realistic length)', () => {
    const k = 'sk-proj-' + 'Zz0011AaBb'.repeat(5)
    const out = redactSecrets(`key=${k}`)
    expect(out).not.toContain(k)
    expect(out).toContain('sk-<redacted>')
  })

  it('redacts Google AIza… keys', () => {
    const k = 'AIzaSyA' + 'b'.repeat(32) // AIza + 35 chars
    const out = redactSecrets(`x-goog-api-key: ${k} failed`)
    expect(out).not.toContain(k)
    expect(out).toContain('AIza<redacted>')
  })

  it('does NOT mangle ordinary text that merely starts with sk-', () => {
    expect(redactSecrets('the sk-learn library')).toBe('the sk-learn library') // too short, hyphen-word
    expect(redactSecrets('sku-12345 in stock')).toBe('sku-12345 in stock') // not an sk- prefix
  })

  it('leaves ordinary content untouched', () => {
    expect(redactSecrets('plain error, nothing secret; pod 925')).toBe('plain error, nothing secret; pod 925')
  })
})
