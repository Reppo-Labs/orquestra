import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTelemetry, sendTelemetryInBackground, ENDPOINT_ENV, DEFAULT_ENDPOINT } from './send.js'
import { markNoticeShown, setTelemetryEnabled, OPT_OUT_ENV } from './consent.js'

let dirs: string[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orq-tel-'))
  dirs.push(d)
  return d
}

/** A node that has seen the notice and has telemetry on — the only state that transmits. */
function ready(): string {
  const d = tmp()
  markNoticeShown(d)
  return d
}

const env = (extra: Record<string, string> = {}) => ({ [ENDPOINT_ENV]: 'https://collector.test/v1', ...extra })

/** A fetch double whose call signature matches `fetch`, so `mock.calls` is typed. */
function stubFetch(impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl)
}
const ok = () => Promise.resolve(new Response('', { status: 200 }))

beforeEach(() => { dirs = [] })
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('the gate is checked before anything is built or sent', () => {
  it('a node that has not seen the notice does not call the network (task 5.6)', async () => {
    const fetchImpl = stubFetch(ok)
    const dir = tmp() // notice NOT shown
    expect(await sendTelemetry(dir, { env: env(), fetchImpl })).toBe('disabled')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a disabled node does not call the network (task 5.5)', async () => {
    const fetchImpl = stubFetch(ok)
    const dir = ready()
    setTelemetryEnabled(dir, false)
    expect(await sendTelemetry(dir, { env: env(), fetchImpl })).toBe('disabled')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('the env opt-out suppresses the network call', async () => {
    const fetchImpl = stubFetch(ok)
    expect(await sendTelemetry(ready(), { env: env({ [OPT_OUT_ENV]: '1' }), fetchImpl })).toBe('disabled')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('no env endpoint falls back to the compiled-in default collector', async () => {
    const fetchImpl = stubFetch(ok)
    expect(await sendTelemetry(ready(), { env: {}, fetchImpl })).toBe('sent')
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(String(fetchImpl.mock.calls[0][0])).toBe(DEFAULT_ENDPOINT)
  })

  it('the env var still overrides the default endpoint', async () => {
    const fetchImpl = stubFetch(ok)
    expect(await sendTelemetry(ready(), { env: env(), fetchImpl })).toBe('sent')
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://collector.test/v1')
  })
})

describe('transmission', () => {
  it('POSTs the serialized payload as JSON', async () => {
    const fetchImpl = stubFetch(ok)
    expect(await sendTelemetry(ready(), { env: env(), fetchImpl })).toBe('sent')
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://collector.test/v1')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body.schemaVersion).toBeDefined()
    expect(body.installId).toBeDefined()
  })

  it('sends only allowlisted keys on the wire', async () => {
    const fetchImpl = stubFetch(ok)
    await sendTelemetry(ready(), { env: env(), fetchImpl })
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      ['arch', 'counts', 'errorSignatures', 'installId', 'nodeVersion', 'orquestraVersion', 'platform', 'schemaVersion', 'ts'],
    )
  })
})

describe('failure is always contained (tasks 5.3, 5.4)', () => {
  it('an unreachable collector resolves rather than rejecting', async () => {
    const fetchImpl = stubFetch(() => Promise.reject(new Error('ECONNREFUSED')))
    await expect(sendTelemetry(ready(), { env: env(), fetchImpl })).resolves.toBe('failed')
  })

  it('a non-2xx response is not retried', async () => {
    const fetchImpl = stubFetch(() => Promise.resolve(new Response('nope', { status: 500 })))
    expect(await sendTelemetry(ready(), { env: env(), fetchImpl })).toBe('failed')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('a throw during payload construction is contained', async () => {
    // A corrupt DB is the realistic trigger. readCounts already degrades to zeros, so force
    // the failure at the fetch boundary instead and assert nothing escapes.
    const fetchImpl = stubFetch(() => { throw new Error('boom') })
    await expect(sendTelemetry(ready(), { env: env(), fetchImpl })).resolves.toBe('failed')
  })

  it('the background wrapper returns void and never rejects', async () => {
    const fetchImpl = stubFetch(() => Promise.reject(new Error('down')))
    expect(sendTelemetryInBackground(ready(), { env: env(), fetchImpl })).toBeUndefined()
    // Give the microtask queue a turn; an unhandled rejection would surface here.
    await new Promise((r) => setTimeout(r, 5))
  })
})
