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
// `page` and `limit` are IGNORED by the server (limit=3 returned 3343 rows);
// `filters[subnet]` is what actually bounds a read, and the per-datanet cap is
// therefore applied CLIENT-SIDE below. `filters[currentEpoch]` does not filter
// by the value passed (142 and 143 both returned the same currently-valid pod)
// so it is deliberately not sent: the node wants the datanet's pods, not just
// this epoch's.
//
// Envelopes are read STRICTLY — `data.subnets` and `data.pods`, with no
// lenient fallback to a bare array or another key. A lenient reader is exactly
// what let the gateway's WRONG envelope pass eleven green unit tests; shape
// drift must be a loud failure, not a silent empty read. Every non-2xx and
// every unparseable or drifted body THROWS (→ the worker :fail-s the job,
// retryable) — never "no evidence". Non-2xx throws a typed DatanetError
// carrying the status, so the worker's 401/403 credential backoff still fires
// if a proxy or WAF ever refuses these public endpoints.
// Adjust paths/field names here only; nothing outside this file knows the wire
// shape. The live guard is datanetClient.live.test.ts (DATANET_LIVE=1) — a
// mock can never falsify a vendor's shape.
import { z } from 'zod'
import { DatanetError, type AccessibleDatanet, type DatanetSource } from './datanet.js'
import type { DatanetPod } from './types.js'

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
        name: z.string().default(''),
        description: z.string().default(''),
        privateSubnetId: z.string().min(1),
      }),
    ),
  }),
})

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
    async fetchPods(datanetId: string, limit: number): Promise<DatanetPod[]> {
      const path = `/public/pods?filters[subnet]=${encodeURIComponent(datanetId)}`
      const parsed = podsEnvelope.safeParse(await getJson(path))
      if (!parsed.success) throw new Error(`datanet api: /public/pods did not answer { data: { pods: [...] } } for datanet ${datanetId} — see datanetClient.ts`)
      // The server ignores `limit`, so the per-datanet read cap is enforced here.
      return parsed.data.data.pods
        .slice(0, limit)
        .map((p) => ({ datanetId: p.privateSubnetId, podId: p.id, name: p.name, text: p.description }))
    },
  }
}
