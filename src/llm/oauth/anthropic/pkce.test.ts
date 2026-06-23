import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  generatePkce,
  buildAuthorizeUrl,
  exchangeCode,
  refresh,
  CLIENT_ID,
  AUTHORIZE_URL,
  TOKEN_URL,
  REDIRECT_URI,
} from './pkce.js'

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('generatePkce', () => {
  it('returns a base64url verifier and its S256 challenge', () => {
    const { verifier, challenge, state } = generatePkce()
    // verifier is high-entropy base64url (RFC 7636: 43–128 chars)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(state).toMatch(/^[A-Za-z0-9_-]{10,}$/)
    // challenge is the base64url-encoded SHA-256 of the verifier
    expect(challenge).toBe(b64url(createHash('sha256').update(verifier).digest()))
  })

  it('produces a different verifier each call', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier)
  })
})

describe('buildAuthorizeUrl', () => {
  it('targets claude.ai with all required PKCE + client params', () => {
    const url = new URL(buildAuthorizeUrl({ challenge: 'CHAL', state: 'STATE' }))
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(url.searchParams.get('code_challenge')).toBe('CHAL')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('STATE')
    expect(url.searchParams.get('scope')).toContain('user:inference')
  })
})

describe('exchangeCode', () => {
  it('splits code#state, POSTs the auth-code grant, and computes expires_at from now', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = async (url: string | URL, init?: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') })
      return {
        ok: true,
        json: async () => ({ access_token: 'sk-ant-oat01-A', refresh_token: 'sk-ant-ort01-R', expires_in: 3600 }),
      } as Response
    }
    const tokens = await exchangeCode(
      { codeAndState: 'THE_CODE#THE_STATE', verifier: 'VER' },
      { fetch: fetchImpl as typeof fetch, now: () => 1_000_000 },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(TOKEN_URL)
    expect(calls[0].body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'THE_CODE',
      state: 'THE_STATE',
      code_verifier: 'VER',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    })
    expect(tokens).toEqual({ access_token: 'sk-ant-oat01-A', refresh_token: 'sk-ant-ort01-R', expires_at: 1_000_000 + 3600_000 })
  })

  it('rejects a state that does not match expectedState (CSRF guard) before any network call', async () => {
    const fetchImpl = vi.fn()
    await expect(
      exchangeCode({ codeAndState: 'code#ATTACKER', verifier: 'v', expectedState: 'MINE' }, { fetch: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/state mismatch/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws when the token endpoint returns a non-ok response', async () => {
    const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'bad_verifier' } as Response)
    await expect(
      exchangeCode({ codeAndState: 'c#s', verifier: 'v' }, { fetch: fetchImpl as typeof fetch }),
    ).rejects.toThrow(/400/)
  })

  it('throws when the token response omits expires_in (avoids a NaN expiry → refresh hot-loop)', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ access_token: 'A', refresh_token: 'R' }) } as Response)
    await expect(
      exchangeCode({ codeAndState: 'c#s', verifier: 'v' }, { fetch: fetchImpl as typeof fetch }),
    ).rejects.toThrow(/expires_in/)
  })

  it('throws when the token response omits access_token', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ refresh_token: 'R', expires_in: 10 }) } as Response)
    await expect(
      exchangeCode({ codeAndState: 'c#s', verifier: 'v' }, { fetch: fetchImpl as typeof fetch }),
    ).rejects.toThrow(/access_token/)
  })
})

describe('refresh', () => {
  it('POSTs the refresh grant and returns the rotated token set', async () => {
    const calls: Array<Record<string, unknown>> = []
    const fetchImpl = async (_url: string | URL, init?: { body?: string }) => {
      calls.push(JSON.parse(init?.body ?? '{}'))
      return {
        ok: true,
        json: async () => ({ access_token: 'sk-ant-oat01-NEW', refresh_token: 'sk-ant-ort01-NEW', expires_in: 28800 }),
      } as Response
    }
    const tokens = await refresh('sk-ant-ort01-OLD', { fetch: fetchImpl as typeof fetch, now: () => 0 })
    expect(calls[0]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'sk-ant-ort01-OLD', client_id: CLIENT_ID })
    expect(tokens).toEqual({ access_token: 'sk-ant-oat01-NEW', refresh_token: 'sk-ant-ort01-NEW', expires_at: 28800_000 })
  })

  it('keeps the old refresh_token when the response omits a new one', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ access_token: 'A', expires_in: 10 }) } as Response)
    const tokens = await refresh('KEEP_ME', { fetch: fetchImpl as typeof fetch, now: () => 0 })
    expect(tokens.refresh_token).toBe('KEEP_ME')
  })

  it('throws on a non-ok refresh (e.g. revoked grant)', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'invalid_grant' } as Response)
    await expect(refresh('dead', { fetch: fetchImpl as typeof fetch })).rejects.toThrow(/401/)
  })
})
