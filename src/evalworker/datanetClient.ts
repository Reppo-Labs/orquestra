// HTTP binding of the DatanetSource port to the Reppo public datanet API.
//
// PROBED LIVE 2026-09-04 against https://reppo.ai/api/v1. Both endpoints are
// PUBLIC and UNAUTHENTICATED — no credential is sent, and there is no apiKey
// option to pass one. (The gateway binds the same API from the other side in
// eval-api's src/datanet/client.ts, which reads ONE pod for existence; the
// node needs the two LIST endpoints below.)
//
//   GET {base}/public/subnets
//     200 -> { "data": { "subnets": [ { id, subnetName, subnetDescription,
//                                       tokenId, chainId, status, ... } ] } }
//     19 rows as probed.
//
//   GET {base}/public/pods?filters[subnet]=<subnetCuid>
//     200 -> { "data": { "pods": [ { id, name, description, url, tokenId,
//                                    privateSubnetId, chainId,
//                                    podValidityEpoch, creator, ... } ] } }
//     A pod's text is `description` (avg ~1154 chars, never empty); there is
//     NO `text` field. A pod's `tokenId` is the POD's own on-chain id and is
//     NEVER the datanet's — do not read an identity out of it.
//
// A datanet is identified by its SUBNET CUID (e.g. cms3uejpj0001jf040zjgwqwm),
// which is what a pod row names as `privateSubnetId`. The numeric `tokenId` on
// a subnet row was REJECTED as the identifier for two independent reasons:
// it collides across chains (tokenId "2" is one subnet on 8453 and a different
// one on 4663), and 26 subnets have pods while only 19 appear in
// /public/subnets — so 66 pods have no numeric id at all.
//
// PAGINATION CHANGED UNDER US. Probed 2026-09-04: `page` and `limit` were
// ignored and one request returned the whole subnet (limit=3 -> 3343 rows).
// Re-probed 2026-09-10: limit=3 returns 3, an unparameterised read returns 20,
// and `page` works (page 2 shares no ids with page 1). So the unpaged read this
// file used to make had silently shrunk to the first 20 rows — 5.2% of the
// 383-row TradingGym subnet — and neither the type nor the tests could see it
// (issue #222). fetchPods now pages to exhaustion and THROWS rather than return
// a prefix: the server's row order is createdAt-ish, not relevance, so a pod
// past the cut is simply unreachable, and a short read must never reach the
// ranker looking complete. `filters[currentEpoch]` does not filter by the value
// passed (142 and 143 both returned the same currently-valid pod) so it is
// deliberately not sent: the node wants the datanet's pods, not this epoch's.
//
// Envelopes are read STRICTLY — `data.subnets` and `data.pods`, with no
// lenient fallback to a bare array or another key. A lenient reader is exactly
// what let the gateway's WRONG envelope pass eleven green unit tests; shape
// drift must be a loud failure, not a silent empty read. Every non-2xx and
// every unparseable or drifted body THROWS (→ the worker :fail-s the job,
// retryable) — never "no evidence". Non-2xx throws a typed DatanetError
// carrying the status, so the worker's 401/403 backoff still fires if a proxy
// or WAF ever refuses these public endpoints (there is no credential to fix).
// Adjust paths/field names here only; nothing outside this file knows the wire
// shape. The live guard is datanetClient.live.test.ts (DATANET_LIVE=1) — a
// mock can never falsify a vendor's shape.
import { z } from 'zod'
import { DatanetError, type AccessibleDatanet, type DatanetSource } from './datanet.js'
import type { DatanetPod } from './types.js'

/** The canonical catalog: what eval-api resolves citations against. */
export const CANONICAL_DATANET_API_URL = 'https://reppo.ai/api/v1'

/** Where this node reads evidence. Deliberately NOT `platformBase()`:
 *  on a robinhood-network node that is https://robinhood.reppo.ai/api/v1,
 *  which lists subnets that do not exist on reppo.ai (probed 2026-09-07:
 *  Genesis Playground cms127jgm… — its pods answer 404 on reppo.ai), while
 *  the gateway verifies every citation against reppo.ai ONLY. A node citing
 *  such a pod earns 422 UNRESOLVABLE_CITATION, a discard recorded against
 *  it, and a cache flush. Evidence must be read from the SAME catalog the
 *  gateway verifies against, on every network. `EVAL_DATANET_API_URL`
 *  overrides (staging etc.) — set it to the gateway's catalog, not yours. */
export function datanetApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.EVAL_DATANET_API_URL?.trim() || CANONICAL_DATANET_API_URL
}

export interface DatanetClientOpts {
  baseUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const subnetsEnvelope = z.object({
  data: z.object({
    subnets: z.array(z.object({ id: z.string().min(1), subnetName: z.string().default('') })),
  }),
})

const podsEnvelope = z.object({
  data: z.object({
    pods: z.array(
      z.object({
        id: z.string().min(1),
        // nullish, not default(): zod's default covers undefined only, and a
        // single null row must not make the WHOLE subnet unreadable (every
        // job would then :fail on it forever). id/privateSubnetId stay strict.
        name: z.string().nullish().transform((v) => v ?? ''),
        description: z.string().nullish().transform((v) => v ?? ''),
        privateSubnetId: z.string().min(1),
      }),
    ),
  }),
})

/** Rows per /public/pods request. 100 is the server's ceiling — asking for 500
 *  silently returns 100, so a larger value would read as a short page. */
export const PODS_PAGE_SIZE = 100
/** Page bound, so one runaway datanet cannot stall a job. 10,000 pods is ~6x the
 *  largest subnet seen (ArAIstotle, ~1.7k); hitting it throws rather than truncates. */
export const MAX_PODS_PAGES = 100

export function makeDatanetClient(opts: DatanetClientOpts): DatanetSource {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 30_000
  const base = opts.baseUrl.replace(/\/+$/, '')

  async function getJson(path: string): Promise<unknown> {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 300)
      } catch {
        /* body unreadable — status alone is the message */
      }
      throw new DatanetError(res.status, `datanet api HTTP ${res.status} for ${path}${detail ? ` — ${detail}` : ''}`)
    }
    return res.json()
  }

  return {
    async listAccessible(): Promise<AccessibleDatanet[]> {
      const parsed = subnetsEnvelope.safeParse(await getJson('/public/subnets'))
      if (!parsed.success) throw new Error('datanet api: /public/subnets did not answer { data: { subnets: [...] } } — see datanetClient.ts')
      return parsed.data.data.subnets.map((s) => ({ datanetId: s.id, name: s.subnetName }))
    },
    async fetchPods(datanetId: string): Promise<DatanetPod[]> {
      const subnet = encodeURIComponent(datanetId)
      const out: DatanetPod[] = []
      const seen = new Set<string>()
      for (let page = 1; page <= MAX_PODS_PAGES; page++) {
        const path = `/public/pods?filters[subnet]=${subnet}&limit=${PODS_PAGE_SIZE}&page=${page}`
        const parsed = podsEnvelope.safeParse(await getJson(path))
        if (!parsed.success) throw new Error(`datanet api: /public/pods did not answer { data: { pods: [...] } } for datanet ${datanetId} — see datanetClient.ts`)
        const rows = parsed.data.data.pods
        let added = 0
        for (const p of rows) {
          if (seen.has(p.id)) continue
          seen.add(p.id)
          out.push({ datanetId: p.privateSubnetId, podId: p.id, name: p.name, text: p.description })
          added++
        }
        // Over the requested size means `limit` is ignored again (the pre-2026-09-10
        // server): that response IS the whole subnet, so stop — this is complete.
        if (rows.length > PODS_PAGE_SIZE) break
        if (rows.length < PODS_PAGE_SIZE) return out
        // A full page that adds nothing new means `page` is not being honoured, so
        // the rest is unreachable. Throw: an outage, never a short read (datanet.ts).
        if (added === 0) {
          throw new Error(
            `datanet api: /public/pods returned page ${page} identical to the previous page for datanet ${datanetId} — pagination is not being honoured, so this read is truncated at ${out.length} pods`,
          )
        }
      }
      if (seen.size >= PODS_PAGE_SIZE * MAX_PODS_PAGES) {
        throw new Error(
          `datanet api: datanet ${datanetId} exceeded the ${MAX_PODS_PAGES}-page read bound (${out.length} pods) — refusing to judge on a truncated read; raise MAX_PODS_PAGES in datanetClient.ts`,
        )
      }
      return out
    },
  }
}
