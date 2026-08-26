// src/telemetry/send.ts — transmission. Fire-and-forget, and structurally incapable of
// affecting the node.
//
// A node earns only by voting and minting on-chain. A blocking or throwing telemetry call
// would convert a collector outage into lost emissions across every operator at once —
// strictly worse than never having built telemetry. So every failure here is swallowed
// after a single debug line, there is no retry, and the caller is never given a promise it
// might await on the cycle's critical path.
//
// The endpoint ships as a compiled-in default so a fresh install reports without any
// configuration (the "inert until configured" stance predates the collector existing —
// it is deployed now). ORQUESTRA_TELEMETRY_ENDPOINT still overrides for self-hosted
// collectors, and opting out is a CONSENT decision (`telemetry --off`,
// ORQUESTRA_TELEMETRY_DISABLED, or the onboarding choice), not an endpoint one.
import { shouldTransmit } from './consent.js'
import { buildPayload, serializePayload, type TelemetryPayload } from './payload.js'
import type { ErrorSignature } from './signature.js'

/** Overrides the collector URL (self-hosted collectors, staging). Absent or empty → the
 *  compiled-in default. Disabling telemetry goes through consent, never through this. */
export const ENDPOINT_ENV = 'ORQUESTRA_TELEMETRY_ENDPOINT'

/** Reppo's hosted collector (AWS API Gateway -> Lambda -> DynamoDB, 90-day TTL; see
 *  docs/telemetry.md and collector/README.md). */
export const DEFAULT_ENDPOINT = 'https://njivst0b99.execute-api.us-west-2.amazonaws.com/v1/reports'

/** Hard ceiling on a single attempt. Short on purpose: this is best-effort background
 *  work, and a hung socket must not keep the process alive at shutdown. */
export const SEND_TIMEOUT_MS = 5_000

export interface SendOptions {
  errorSignatures?: ErrorSignature[]
  env?: NodeJS.ProcessEnv
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export type SendOutcome = 'sent' | 'disabled' | 'no-endpoint' | 'failed'

export function endpointFor(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[ENDPOINT_ENV] ?? '').trim()
  return raw === '' ? DEFAULT_ENDPOINT : raw
}

/** Attempt one transmission. Resolves to an outcome and NEVER rejects.
 *
 *  Order matters: the consent gate is checked before the payload is built, so a disabled
 *  node does no work and — more importantly — a node that has not yet seen the notice
 *  never even constructs a payload. */
export async function sendTelemetry(dataDir: string, opts: SendOptions = {}): Promise<SendOutcome> {
  const env = opts.env ?? process.env
  try {
    if (!shouldTransmit(dataDir, env)) return 'disabled'

    const endpoint = endpointFor(env)
    if (endpoint === null) return 'no-endpoint'

    const payload: TelemetryPayload = buildPayload(dataDir, { errorSignatures: opts.errorSignatures })
    const doFetch = opts.fetchImpl ?? fetch

    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: serializePayload(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })

    // A non-2xx is not retried. The collector's job is to tolerate loss; ours is to never
    // become a source of load or latency. The next cycle sends fresh counts anyway.
    return res.ok ? 'sent' : 'failed'
  } catch {
    // Deliberately silent at info level: a node with no network would otherwise print a
    // telemetry warning every cycle, training operators to ignore real errors.
    return 'failed'
  }
}

/** Fire-and-forget wrapper for the cycle path. Returns void immediately; the promise is
 *  consumed here so an unhandled rejection can never surface, and so no caller can
 *  accidentally `await` telemetry on the critical path. */
export function sendTelemetryInBackground(dataDir: string, opts: SendOptions = {}): void {
  void sendTelemetry(dataDir, opts).catch(() => undefined)
}
