// Contract suite for the eval gateway's lease/ack protocol — the seam between
// this repo's evalworker and the eval-api gateway. The SAME fixture files are
// vendored in both repos (eval-api: fixtures/lease-ack/); the checksum test
// pins byte equality so the two sides cannot drift silently: any deliberate
// protocol change must update the fixtures AND the checksums in BOTH repos in
// the same change.
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { GatewayClient, GatewayError } from '../../src/evalworker/client.js'
import type { EvalAnswer, EvalDenial, LeasedJob } from '../../src/evalworker/types.js'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'lease-ack')
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8')
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

// Pinned in BOTH repos — eval-api pins the same bytes via
// fixtures/lease-ack/CHECKSUMS.sha256 (`npm run fixtures:check` in its CI).
// Copied verbatim from eval-api @ 3d97995 (branch datanet-api-binding).
const CHECKSUMS: Record<string, string> = {
  'complete-request.json': '19e9ed86672169c1ab223e89062ee9798ad9e12042af04cf50ebc6b1848f0e9e',
  'deny-request.json': '90e8957a7e1de201cd34a841b5b53a7003267585477a9e4be7924f9108b6edcc',
  'error-codes.json': 'cfcc493d5c2ece4d3abe1a3c88556811849655b596ae6b4a0f4bed237f6d992e',
  'fail-request.json': '73fde433d66db0ee93e14e84fc31246e309939134aef874521bf54af8108714d',
  'lease-response.json': 'a011ed4a499532a05e3191977f4b9ce1d80a635a2c28c32762ab419fbdabefc7',
}

const makeClient = (fetchImpl: typeof fetch) =>
  new GatewayClient({ baseUrl: 'https://gw', agentId: 'agent-7', apiKey: 'secret', fetchImpl })

/** fetch stub that records the parsed body and answers 200 `{}`. */
const capturing = () => {
  const calls: { url: string; body: unknown; headers: Record<string, string> | undefined }[] = []
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> | undefined })
    return new Response('{}', { status: 200 })
  })
  return { calls, fetchImpl }
}

describe('lease/ack contract fixtures', () => {
  it('fixtures byte-match the pinned checksums (drift guard)', () => {
    for (const [file, expected] of Object.entries(CHECKSUMS)) {
      expect(`${file}:${sha(read(file))}`).toBe(`${file}:${expected}`)
    }
  })

  it('the corpus-snapshot fixture no longer exists (evidence is node-side now)', () => {
    expect(existsSync(join(DIR, 'corpus-snapshot.json'))).toBe(false)
  })

  it('client parses the lease-response fixture into a LeasedJob', async () => {
    const fetchImpl = vi.fn(async () => new Response(read('lease-response.json'), { status: 200 }))
    const job = (await makeClient(fetchImpl).lease()) as LeasedJob
    expect(job).toEqual({
      jobId: 'job_01J9ZX4T8RE',
      request: {
        type: 'plan',
        payload: expect.stringMatching(/^Long ETH-PERP/),
        criteria: ['entry conditions are historically profitable, not curve-fit', 'risk sizing survives a 10% adverse candle'],
        context: 'Autonomous vault agent, $50k AUM.',
      },
      epoch: 128,
      answerCutoff: '2026-08-27T01:00:00.000Z',
    })
  })

  it('client rejects an old-shape lease (corpusUrl/corpusVersion/datanetId) as version skew', async () => {
    const old = { ...JSON.parse(read('lease-response.json')), datanetId: 'cms3uejpj0001jf040zjgwqwm', corpusUrl: 'https://bucket/corpus.json', corpusVersion: '20260826T110000Z' }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(old), { status: 200 }))
    const err = await makeClient(fetchImpl).lease().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).message).toMatch(/shape mismatch \(gateway\/worker version skew\?\)/)
  })

  it('client submits a :complete body shaped exactly like the fixture', async () => {
    const { calls, fetchImpl } = capturing()
    const answer = JSON.parse(read('complete-request.json')) as EvalAnswer
    await makeClient(fetchImpl).complete(answer)
    expect(calls[0]?.body).toEqual(answer)
    expect(calls[0]?.url).toBe('https://gw/v1/node/jobs/job_01J9ZX4T8RE:complete')
    // The wire shape is what the gateway's .strict() schema accepts: object
    // citations, no evidenceBasis. A datanetId is the SUBNET CUID string —
    // never the numeric tokenId (it collides across chains).
    expect(answer.verdicts[0]?.citations[0]).toEqual({ datanetId: 'cms3uejpj0001jf040zjgwqwm', podId: 'cmth6huiz0000l704x8lt4te2' })
    expect('evidenceBasis' in answer).toBe(false)
  })

  it('client submits a :deny body shaped exactly like the fixture', async () => {
    const { calls, fetchImpl } = capturing()
    const denial = JSON.parse(read('deny-request.json')) as EvalDenial
    await makeClient(fetchImpl).deny(denial.jobId, denial.reason, denial.datanetsSearched)
    expect(calls[0]?.body).toEqual(denial)
    expect(calls[0]?.url).toBe('https://gw/v1/node/jobs/job_01J9ZX4T8RE:deny')
  })

  it('client submits a :fail body shaped exactly like the fixture', async () => {
    const { calls, fetchImpl } = capturing()
    const fixture = JSON.parse(read('fail-request.json')) as { jobId: string; reason: string }
    await makeClient(fetchImpl).fail(fixture.jobId, fixture.reason)
    expect(calls[0]?.body).toEqual({ reason: fixture.reason })
    expect(calls[0]?.url).toBe('https://gw/v1/node/jobs/job_01J9ZX4T8RE:fail')
  })

  it('auth headers ride every gateway call', async () => {
    const { calls, fetchImpl } = capturing()
    const client = makeClient(fetchImpl)
    await client.lease().catch(() => {}) // `{}` is not a lease — shape error is fine here
    await client.deny('j', 'r', ['cms3uejpj0001jf040zjgwqwm'])
    await client.fail('j', 'r')
    expect(calls).toHaveLength(3)
    for (const c of calls) expect(c.headers).toMatchObject({ 'x-agent-id': 'agent-7', 'x-api-key': 'secret' })
  })

  it('the error-codes fixture names the deny rejections the worker treats as terminal', () => {
    const codes = JSON.parse(read('error-codes.json')) as { deny: Record<string, string[]> }
    expect(codes.deny['409']).toEqual(expect.arrayContaining(['PAST_CUTOFF', 'ALREADY_ANSWERED']))
    expect(codes.deny['400']).toEqual(expect.arrayContaining(['INVALID_DENIAL']))
  })
})
