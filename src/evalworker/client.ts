// HTTP client for the eval gateway's node API. Auth = the node's existing
// platform agent identity (agentId + apiKey), same credentials the reppo CLI
// uses. fetch is injectable for tests and the contract fixture suite.
//
// Two hard lessons are baked in here:
//  - Responses are zod-validated, not cast: this is a cross-repo wire boundary
//    (pinned by test/fixtures/lease-ack/), and version skew must fail loudly
//    with a shape error, not as a TypeError three calls later.
//  - Every fetch carries an AbortSignal timeout: a dead-but-open connection
//    would otherwise hang a lease forever with no error — invisible stall,
//    wedged shutdown.
import { z } from 'zod'
import type { EvalAnswer, EvalDenial, FailReason, LeasedJob } from './types.js'
import { EVAL_TYPES } from './types.js'

// `.strict()`: a lease still carrying the retired corpus fields (corpusUrl /
// corpusVersion / top-level datanetId) is an OLD gateway build — evidence is
// node-side now, and judging against a gateway that expects corpus-pinned
// citations would fail every :complete. Surface it as version skew instead.
// The request is accepted in BOTH shapes for one release: by reference
// (payloadUrl + payloadBytes + payloadSha256, the metered gateway) and inline
// (payload only, the gateway before it). At least one must be present, and a
// reference must come with its size and hash — a lease that names a URL but
// no hash cannot be verified and is refused as skew.
const leasedJobSchema = z
  .object({
    jobId: z.string().min(1),
    request: z
      .object({
        type: z.enum(EVAL_TYPES),
        criteria: z.array(z.string()).min(1),
        context: z.string().optional(),
        payloadUrl: z.string().url().optional(),
        payloadBytes: z.number().int().nonnegative().optional(),
        payloadSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        payload: z.string().optional(),
      })
      .refine((r) => r.payload !== undefined || r.payloadUrl !== undefined, { message: 'lease carries neither payload nor payloadUrl' })
      .refine((r) => r.payloadUrl === undefined || (r.payloadBytes !== undefined && r.payloadSha256 !== undefined), { message: 'payloadUrl without payloadBytes + payloadSha256' }),
    answerCutoff: z.string(),
  })
  .strict()

export interface GatewayClientOpts {
  baseUrl: string
  agentId: string
  apiKey: string
  fetchImpl?: typeof fetch
  /** Long-poll wait the lease endpoint is asked for (seconds). */
  leaseWaitSeconds?: number
  /** Hard timeout for non-lease requests (ms). */
  requestTimeoutMs?: number
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

/** Read a truncated response body for error messages — the gateway's body says
 *  WHY (bad key, unregistered agent), and discarding it turns a config mistake
 *  into an undiagnosable retry loop. Body text only, bounded, never throws. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 300)
    return text ? ` — ${text}` : ''
  } catch {
    return ''
  }
}

export class GatewayClient {
  private readonly fetchImpl: typeof fetch
  private readonly leaseWaitSeconds: number
  private readonly requestTimeoutMs: number

  constructor(private readonly opts: GatewayClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.leaseWaitSeconds = opts.leaseWaitSeconds ?? 25
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-agent-id': this.opts.agentId,
      'x-api-key': this.opts.apiKey,
    }
  }

  /** Long-poll for a job. 200 → a job to serve; 204 → nothing available. */
  async lease(): Promise<LeasedJob | null> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/v1/node/jobs:lease`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ wait: this.leaseWaitSeconds }),
      // 2× the long-poll window + slack: generous for a slow gateway, fatal
      // for a hung connection.
      signal: AbortSignal.timeout(this.leaseWaitSeconds * 2_000 + 10_000),
    })
    if (res.status === 204) return null
    if (!res.ok) throw new GatewayError(res.status, `lease failed: HTTP ${res.status}${await errorDetail(res)}`)
    const parsed = leasedJobSchema.safeParse(await res.json())
    if (!parsed.success) {
      throw new GatewayError(res.status, `lease response shape mismatch (gateway/worker version skew?): ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`)
    }
    return parsed.data
  }

  /** Submit this node's answer. Idempotent gateway-side per jobId + node. */
  async complete(answer: EvalAnswer): Promise<void> {
    const res = await this.fetchImpl(
      `${this.opts.baseUrl}/v1/node/jobs/${encodeURIComponent(answer.jobId)}:complete`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(answer), signal: AbortSignal.timeout(this.requestTimeoutMs) },
    )
    if (!res.ok) throw new GatewayError(res.status, `complete failed: HTTP ${res.status}${await errorDetail(res)}`)
  }

  /** Report that this node cannot serve the job. `reason` is the pinned
   *  vocabulary (error-codes.json → fail); `detail` is free text for the
   *  operator. The gateway counts per reason, so a fleet-wide
   *  PAYLOAD_FETCH_FAILED is visible as itself, not as "no nodes online". */
  async fail(jobId: string, reason: FailReason, detail?: string): Promise<void> {
    const body = { jobId, reason, ...(detail ? { detail: detail.slice(0, 2000) } : {}) }
    const res = await this.fetchImpl(
      `${this.opts.baseUrl}/v1/node/jobs/${encodeURIComponent(jobId)}:fail`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(this.requestTimeoutMs) },
    )
    if (!res.ok) throw new GatewayError(res.status, `fail failed: HTTP ${res.status}${await errorDetail(res)}`)
  }

  /** Report that this node looked and found no evidence for the job (the
   *  relevance gate left at least one criterion unsupported). Not a fault:
   *  the gateway counts denials at settlement. */
  async deny(jobId: string, reason: string, datanetsSearched: string[]): Promise<void> {
    const body: EvalDenial = { jobId, reason, datanetsSearched }
    const res = await this.fetchImpl(
      `${this.opts.baseUrl}/v1/node/jobs/${encodeURIComponent(jobId)}:deny`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(this.requestTimeoutMs) },
    )
    if (!res.ok) throw new GatewayError(res.status, `deny failed: HTTP ${res.status}${await errorDetail(res)}`)
  }
}
