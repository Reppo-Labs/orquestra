// Contract suite for the eval gateway's lease/ack protocol — the seam between
// this repo's evalworker and the eval-api gateway. The SAME fixture files are
// vendored in both repos (eval-api: fixtures/lease-ack/); the checksum test
// pins byte equality so the two sides cannot drift silently: any deliberate
// protocol change must update the fixtures AND the checksums in BOTH repos in
// the same change.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { GatewayClient } from '../../src/evalworker/client.js'
import type { EvalAnswer, LeasedJob } from '../../src/evalworker/types.js'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'lease-ack')
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8')
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

// Pinned in BOTH repos — see eval-api fixtures/lease-ack/checksums.test.ts.
const CHECKSUMS: Record<string, string> = {
  'lease-response.json': '9db1159daaf1b6e9f8ae0f5a2ef9ca67f03a37bc3c91027af546c922046da06c',
  'complete-request.json': '672c23a9181f741a28ac0d526fa544777518339200041a21e678c46c1d3f0311',
  'fail-request.json': '73fde433d66db0ee93e14e84fc31246e309939134aef874521bf54af8108714d',
  'corpus-snapshot.json': '35a7c0886218be13d08fb42fa1739b02a6a56408930bbb072e1d7d4b06d4ccdc',
}

describe('lease/ack contract fixtures', () => {
  it('fixtures byte-match the pinned checksums (drift guard)', () => {
    for (const [file, expected] of Object.entries(CHECKSUMS)) {
      expect(`${file}:${sha(read(file))}`).toBe(`${file}:${expected}`)
    }
  })

  it('client parses the lease-response fixture into a LeasedJob', async () => {
    const fetchImpl = vi.fn(async () => new Response(read('lease-response.json'), { status: 200 }))
    const client = new GatewayClient({ baseUrl: 'https://gw', agentId: 'a', apiKey: 'k', fetchImpl })
    const job = (await client.lease()) as LeasedJob
    expect(job.jobId).toBe('job_01J9ZX4T8RE')
    expect(job.request.type).toBe('plan')
    expect(job.request.criteria).toHaveLength(2)
    expect(job.corpusUrl).toMatch(/^https:/)
    expect(Date.parse(job.settlementDeadline)).toBeGreaterThan(0)
  })

  it('client submits a :complete body shaped exactly like the fixture', async () => {
    let sent: unknown
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    })
    const client = new GatewayClient({ baseUrl: 'https://gw', agentId: 'a', apiKey: 'k', fetchImpl })
    const answer = JSON.parse(read('complete-request.json')) as EvalAnswer
    await client.complete(answer)
    expect(sent).toEqual(answer)
    const url = String(fetchImpl.mock.calls[0]?.[0])
    expect(url).toBe('https://gw/v1/node/jobs/job_01J9ZX4T8RE:complete')
  })

  it('client submits a :fail body shaped exactly like the fixture', async () => {
    let sent: unknown
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    })
    const client = new GatewayClient({ baseUrl: 'https://gw', agentId: 'a', apiKey: 'k', fetchImpl })
    const fixture = JSON.parse(read('fail-request.json')) as { jobId: string; reason: string }
    await client.fail(fixture.jobId, fixture.reason)
    expect(sent).toEqual({ reason: fixture.reason })
  })

  it('client parses the corpus-snapshot fixture', async () => {
    const fetchImpl = vi.fn(async () => new Response(read('corpus-snapshot.json'), { status: 200 }))
    const client = new GatewayClient({ baseUrl: 'https://gw', agentId: 'a', apiKey: 'k', fetchImpl })
    const corpus = await client.fetchCorpus('https://bucket/corpus.json')
    expect(corpus.pods).toHaveLength(2)
    expect(corpus.pods[0]?.podId).toBe('pod:27/482')
  })

  it('auth headers ride every gateway call but never the presigned corpus URL', async () => {
    const calls: { url: string; headers: Record<string, string> | undefined }[] = []
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> | undefined })
      return new Response(read('corpus-snapshot.json'), { status: 200 })
    })
    const client = new GatewayClient({ baseUrl: 'https://gw', agentId: 'agent-7', apiKey: 'secret', fetchImpl })
    await client.lease()
    await client.fetchCorpus('https://bucket/corpus.json?sig=x')
    expect(calls[0]?.headers).toMatchObject({ 'x-agent-id': 'agent-7', 'x-api-key': 'secret' })
    expect(calls[1]?.headers).toBeUndefined()
  })
})
