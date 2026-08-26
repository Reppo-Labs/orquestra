// HTTP client for the eval gateway's node API. Auth = the node's existing
// platform agent identity (agentId + apiKey), same credentials the reppo CLI
// uses. fetch is injectable for tests and the contract fixture suite.
import type { CorpusSnapshot, EvalAnswer, LeasedJob } from './types.js'

export interface GatewayClientOpts {
  baseUrl: string
  agentId: string
  apiKey: string
  fetchImpl?: typeof fetch
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}

export class GatewayClient {
  private readonly fetchImpl: typeof fetch
  constructor(private readonly opts: GatewayClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-agent-id': this.opts.agentId,
      'x-api-key': this.opts.apiKey,
    }
  }

  /** Long-poll for a job. 200 → a job to serve; 204 → nothing available. */
  async lease(waitSeconds = 25): Promise<LeasedJob | null> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/v1/node/jobs:lease`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ wait: waitSeconds }),
    })
    if (res.status === 204) return null
    if (!res.ok) throw new GatewayError(res.status, `lease failed: HTTP ${res.status}`)
    return (await res.json()) as LeasedJob
  }

  /** Submit this node's answer. Idempotent gateway-side per jobId + node. */
  async complete(answer: EvalAnswer): Promise<void> {
    const res = await this.fetchImpl(
      `${this.opts.baseUrl}/v1/node/jobs/${encodeURIComponent(answer.jobId)}:complete`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(answer) },
    )
    if (!res.ok) throw new GatewayError(res.status, `complete failed: HTTP ${res.status}`)
  }

  /** Report that this node cannot serve the job (judge error after retries). */
  async fail(jobId: string, reason: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.opts.baseUrl}/v1/node/jobs/${encodeURIComponent(jobId)}:fail`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify({ reason }) },
    )
    if (!res.ok) throw new GatewayError(res.status, `fail failed: HTTP ${res.status}`)
  }

  /** Fetch the evidence corpus snapshot (presigned URL — no auth headers: the
   *  signature is in the URL, and extra headers break S3 presigning). */
  async fetchCorpus(corpusUrl: string): Promise<CorpusSnapshot> {
    const res = await this.fetchImpl(corpusUrl)
    if (!res.ok) throw new GatewayError(res.status, `corpus fetch failed: HTTP ${res.status}`)
    return (await res.json()) as CorpusSnapshot
  }
}
