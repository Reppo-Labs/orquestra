import { beforeEach, describe, expect, it } from 'vitest'
import { checkPinataPinScopes, resetPinataPreflightCache } from './pinataPreflight.js'

const respond = (status: number, body = ''): typeof fetch =>
  (async () => new Response(body, { status })) as typeof fetch

beforeEach(() => resetPinataPreflightCache())

describe('checkPinataPinScopes', () => {
  it('passes a key the legacy API accepts, and caches the success', async () => {
    let calls = 0
    const counting = (async () => {
      calls++
      return new Response('{"message":"Congratulations!"}', { status: 200 })
    }) as typeof fetch
    expect(await checkPinataPinScopes('jwt-ok', counting)).toEqual({ ok: true })
    expect(await checkPinataPinScopes('jwt-ok', counting)).toEqual({ ok: true })
    expect(calls).toBe(1)
  })

  it('names the Files-scoped-key failure mode on 403 NO_SCOPES_FOUND', async () => {
    const r = await checkPinataPinScopes('jwt-files', respond(403, '{"error":{"reason":"NO_SCOPES_FOUND"}}'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('legacy pinning scopes')
  })

  it('fails closed on other non-2xx statuses', async () => {
    const r = await checkPinataPinScopes('jwt-bad', respond(401))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('HTTP 401')
  })

  it('fails closed on transport failure, without caching', async () => {
    const failing = (async () => { throw new Error('getaddrinfo ENOTFOUND') }) as typeof fetch
    const r = await checkPinataPinScopes('jwt-net', failing)
    expect(r.ok).toBe(false)
    // A later probe with a working transport recovers — failure was not cached.
    expect(await checkPinataPinScopes('jwt-net', respond(200))).toEqual({ ok: true })
  })

  it('rejects a missing key without any network call', async () => {
    const never = (async () => { throw new Error('should not be called') }) as typeof fetch
    const r = await checkPinataPinScopes(undefined, never)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('PINATA_JWT')
  })
})
