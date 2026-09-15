import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { PayloadError, resolvePayload } from './payload.js'
import type { LeasedJob } from './types.js'

const TEXT = 'Long ETH-PERP 3x; -2% stop.'
const BYTES = Buffer.from(TEXT, 'utf8')
const SHA = createHash('sha256').update(BYTES).digest('hex')
const URL = 'https://payloads.example/payload/j1?X-Amz-Signature=SECRET-SIG'

const byRef = (over: Partial<LeasedJob['request']> = {}): LeasedJob => ({
  jobId: 'j1',
  request: { type: 'plan', criteria: ['c'], context: 'ctx', payloadUrl: URL, payloadBytes: BYTES.length, payloadSha256: SHA, ...over },
  answerCutoff: '2026-08-27T01:00:00.000Z',
})

const serving = (body: Buffer | string, status = 200) => vi.fn(async () => new Response(typeof body === 'string' ? body : new Uint8Array(body), { status }))

describe('resolvePayload', () => {
  it('fetches payloadUrl, verifies length + sha256, and returns the gate/judge request shape', async () => {
    const fetchImpl = serving(BYTES)
    const req = await resolvePayload(byRef(), { fetchImpl })
    expect(req).toEqual({ type: 'plan', criteria: ['c'], context: 'ctx', payload: TEXT })
    expect(fetchImpl).toHaveBeenCalledWith(URL, expect.objectContaining({ method: 'GET' }))
  })

  it('prefers the URL over an inline copy (the inline copy is the transition fallback, not the source)', async () => {
    const req = await resolvePayload(byRef({ payload: 'stale inline copy' }), { fetchImpl: serving(BYTES) })
    expect(req.payload).toBe(TEXT)
  })

  it('a lease with no URL (pre-migration gateway) uses the inline payload without any fetch', async () => {
    const fetchImpl = serving(BYTES)
    const req = await resolvePayload(byRef({ payloadUrl: undefined, payloadBytes: undefined, payloadSha256: undefined, payload: 'inline' }), { fetchImpl })
    expect(req.payload).toBe('inline')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a hash mismatch is PAYLOAD_HASH_MISMATCH; a length mismatch too', async () => {
    const wrong = await resolvePayload(byRef(), { fetchImpl: serving(Buffer.from('X'.repeat(BYTES.length))) }).catch((e: unknown) => e)
    expect(wrong).toBeInstanceOf(PayloadError)
    expect((wrong as PayloadError).reason).toBe('PAYLOAD_HASH_MISMATCH')
    const short = await resolvePayload(byRef(), { fetchImpl: serving(Buffer.from('short')) }).catch((e: unknown) => e)
    expect((short as PayloadError).reason).toBe('PAYLOAD_HASH_MISMATCH')
  })

  it('a non-2xx or a thrown fetch is PAYLOAD_FETCH_FAILED', async () => {
    const forbidden = await resolvePayload(byRef(), { fetchImpl: serving('expired', 403) }).catch((e: unknown) => e)
    expect((forbidden as PayloadError).reason).toBe('PAYLOAD_FETCH_FAILED')
    const down = await resolvePayload(byRef(), { fetchImpl: vi.fn(async () => { throw new TypeError(`fetch failed for ${URL}`) }) }).catch((e: unknown) => e)
    expect((down as PayloadError).reason).toBe('PAYLOAD_FETCH_FAILED')
  })

  it('never puts the URL in an error message (it is a bearer token)', async () => {
    const errors = await Promise.all([
      resolvePayload(byRef(), { fetchImpl: serving('x', 403) }).catch((e: unknown) => e),
      resolvePayload(byRef(), { fetchImpl: vi.fn(async () => { throw new TypeError(`fetch failed: ${URL}`) }) }).catch((e: unknown) => e),
      resolvePayload(byRef(), { fetchImpl: serving(Buffer.from('nope')) }).catch((e: unknown) => e),
    ])
    for (const e of errors) {
      expect(e).toBeInstanceOf(PayloadError)
      expect((e as Error).message).not.toContain('SECRET-SIG')
      expect((e as Error).message).not.toContain('payloads.example')
    }
  })

  it('a lease with neither URL nor inline payload is PAYLOAD_FETCH_FAILED (never judged empty)', async () => {
    const e = await resolvePayload(byRef({ payloadUrl: undefined, payload: undefined }), { fetchImpl: serving(BYTES) }).catch((x: unknown) => x)
    expect((e as PayloadError).reason).toBe('PAYLOAD_FETCH_FAILED')
  })
})
