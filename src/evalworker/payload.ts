// Resolving a leased job's payload (eval-api openspec metered-payloads D9).
// The lease carries the payload BY REFERENCE — a short-lived presigned GET
// (`payloadUrl`) plus `payloadBytes` and `payloadSha256` — and, during the
// transition, may also carry it inline. This runs first thing in serve(),
// before any budget is reserved: the URL is slack (15 min), not a budget.
//
// The URL is a bearer token for those bytes: it never appears in an error
// message, a log line, or an activity row.
import { createHash } from 'node:crypto'
import type { EvalJobRequest, LeasedJob } from './types.js'

export type PayloadFailReason = 'PAYLOAD_FETCH_FAILED' | 'PAYLOAD_HASH_MISMATCH'

export class PayloadError extends Error {
  constructor(
    readonly reason: PayloadFailReason,
    message: string,
  ) {
    super(message)
    this.name = 'PayloadError'
  }
}

export interface ResolvePayloadOpts {
  fetchImpl?: typeof fetch
  /** Hard timeout for the object GET (ms). */
  timeoutMs?: number
}

/**
 * Turns a LeasedJob into the request the gate and judge consume. Prefers
 * `payloadUrl`; falls back to the inline `payload` (pre-migration gateway,
 * or the one-release inline copy). Throws PayloadError so the worker can
 * `:fail` with the exact reason and leave the job to other nodes.
 */
export async function resolvePayload(job: LeasedJob, opts: ResolvePayloadOpts = {}): Promise<EvalJobRequest> {
  const { type, criteria, context, payloadUrl, payloadBytes, payloadSha256, payload } = job.request
  const base = { type, ...(criteria !== undefined ? { criteria } : {}), ...(context !== undefined ? { context } : {}) }
  if (!payloadUrl) {
    if (payload === undefined) throw new PayloadError('PAYLOAD_FETCH_FAILED', `job ${job.jobId}: lease carries neither payloadUrl nor payload`)
    return { ...base, payload }
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  let bytes: Buffer
  try {
    const res = await fetchImpl(payloadUrl, { method: 'GET', signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) })
    if (!res.ok) throw new PayloadError('PAYLOAD_FETCH_FAILED', `job ${job.jobId}: payload GET answered HTTP ${res.status}`)
    bytes = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    if (e instanceof PayloadError) throw e
    // Network/timeout: the message must not echo the URL (fetch errors can).
    const name = e instanceof Error ? e.name : 'Error'
    throw new PayloadError('PAYLOAD_FETCH_FAILED', `job ${job.jobId}: payload GET failed (${name})`)
  }
  if (payloadBytes !== undefined && bytes.length !== payloadBytes) {
    throw new PayloadError('PAYLOAD_HASH_MISMATCH', `job ${job.jobId}: fetched ${bytes.length} bytes, lease says ${payloadBytes}`)
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (payloadSha256 !== undefined && digest !== payloadSha256) {
    throw new PayloadError('PAYLOAD_HASH_MISMATCH', `job ${job.jobId}: fetched ${bytes.length} bytes, sha256 differs from payloadSha256`)
  }
  return { ...base, payload: bytes.toString('utf8') }
}
