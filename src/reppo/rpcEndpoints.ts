// src/reppo/rpcEndpoints.ts
// RPC endpoint failover for every raw JSON-RPC read in src/reppo.
//
// WHY: RPC_URL was read as a SINGLE endpoint. When that one serving peer went down (or
// started 5xx-ing / rate-limiting hard), every on-chain read failed for as long as the
// outage lasted: the vote-power budget read failed (votes fell back to legacy dust
// sizing), the yield + rewards-pool reads went unavailable, and the emissions scan threw
// every cycle — an operator-reported "0-vote cycle with no clear error". The node has no
// way to route around a dead peer, and the resulting errors named a bare HTTP status, not
// "your RPC provider is down".
//
// RPC_URL (and REPPO_RPC_URL) now accept a COMMA-SEPARATED list of endpoints. The first is
// the primary; the rest are fallbacks tried in order. Parsing lives HERE, at the src/reppo
// seam, because every consumer (runtime wiring, dashboard prices/routes, index.ts) already
// hands the raw env string to a src/reppo read — so multi-endpoint support needs no change
// outside this directory. The one exception is the `reppo` CLI, which takes a single
// `--rpc-url`: exec.ts passes primaryRpcEndpoint() only.
//
// WHAT FAILS OVER: transport errors (DNS/connect/timeout/abort) and the "peer is unhealthy"
// HTTP statuses — 5xx, 408, 429. NOT 4xx: a 400 is the provider rejecting the REQUEST SHAPE
// (e.g. an eth_getLogs range cap, which emissionsOnchain.ts answers by halving its chunk),
// and re-sending the same bad request to every fallback would only burn quota and hide the
// signal. A JSON-RPC error BODY (200 + {"error":…}, including a contract revert) is a real
// answer from a healthy peer and is returned untouched — failing over on a revert would
// break the claim-probe oracle in emissionsOnchain.ts.
//
// FAIL-OPEN IS PRESERVED: this module never invents a value. When every endpoint fails it
// THROWS (AllRpcEndpointsFailedError) so each caller keeps its existing "unread ⇒ unknown"
// discipline — an unread pool is never a dry pool, an unread budget never silences voting.
import { redactSecrets } from '../util/redact.js'

/** Split a raw RPC_URL env value into an ordered, de-duplicated endpoint list.
 *  Separators: comma, newline and whitespace (a pasted list can carry any of them).
 *  A single URL parses to a one-element list, so the single-endpoint path is unchanged. */
export function parseRpcEndpoints(raw: string | undefined): string[] {
  const parts = (raw ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  return [...new Set(parts)]
}

/** The FIRST endpoint, for consumers that can only take one (the `reppo` CLI's
 *  `--rpc-url`). Empty string when nothing is configured. */
export function primaryRpcEndpoint(raw: string | undefined): string {
  return parseRpcEndpoints(raw)[0] ?? ''
}

/** Every configured endpoint failed. Named + typed so a caller can tell "your RPC
 *  provider(s) are down" from "this specific call reverted". The message carries the
 *  endpoint HOSTS (never the full URL — the path routinely holds a provider API key)
 *  and is redacted anyway as defense-in-depth. */
export class AllRpcEndpointsFailedError extends Error {
  /** how many endpoints were tried. */
  readonly endpoints: number
  constructor(message: string, endpoints: number) {
    super(message)
    this.name = 'AllRpcEndpointsFailedError'
    this.endpoints = endpoints
  }
}

/** Host of an endpoint for logging — never the path (provider keys live there). */
const hostOf = (url: string): string => {
  try { return new URL(url).host } catch { return '<malformed rpc url>' }
}

/** Is this HTTP status "the peer is unhealthy" (⇒ try the next endpoint) rather than
 *  "this request is wrong" (⇒ return it, the caller's own handling applies)? */
const isPeerFailureStatus = (status: number): boolean => status >= 500 || status === 408 || status === 429

/** POST to the first endpoint that answers, falling back through the rest on a transport
 *  failure or an unhealthy-peer status. Returns the Response as-is (including 4xx and
 *  JSON-RPC error bodies) so every existing caller's error handling is untouched.
 *  Throws AllRpcEndpointsFailedError when no endpoint could answer. */
export async function rpcFetch(fetchImpl: typeof fetch, rpcUrl: string, init: RequestInit): Promise<Response> {
  const endpoints = parseRpcEndpoints(rpcUrl)
  if (endpoints.length === 0) throw new Error('no RPC endpoint configured (set RPC_URL)')
  // Single endpoint: byte-for-byte the previous behaviour — one fetch, no wrapping, so a
  // thrown transport error still surfaces verbatim to the caller.
  if (endpoints.length === 1) return fetchImpl(endpoints[0], init)

  const failures: string[] = []
  for (const url of endpoints) {
    try {
      const res = await fetchImpl(url, init)
      if (isPeerFailureStatus(res.status)) {
        failures.push(`${hostOf(url)}: HTTP ${res.status}`)
        continue
      }
      return res
    } catch (e) {
      failures.push(`${hostOf(url)}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  throw new AllRpcEndpointsFailedError(
    redactSecrets(`all ${endpoints.length} configured RPC endpoints failed — ${failures.join('; ')}`),
    endpoints.length,
  )
}
