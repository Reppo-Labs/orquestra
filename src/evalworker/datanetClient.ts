// HTTP binding of the DatanetSource port to the platform's datanet API.
//
// ENDPOINT SHAPE IS PROVISIONAL: the datanet API docs were not in hand when
// this was written (openspec eval-datanet-grounding, design.md Open
// Questions). eval-api's src/datanet/client.ts is an independent PROVISIONAL
// GUESS at the same undocumented API — NOT the same endpoints, and this file
// does not mirror it: the node needs LIST endpoints (what can I read, what is
// in it), the gateway needs an EXISTENCE endpoint for one pod
// (`{base}/api/v1/datanets/{id}/pods/{podId}`). The two bases are separate
// env vars on separate deployments — `EVAL_DATANET_API_URL` here, the
// gateway's `DATANET_API_URL` there — and the node's default `platformBase()`
// ALREADY ends in `/api/v1`, so do not copy the gateway's value into this one.
// Both files change together when the docs land.
//
// The assumed contract here:
//   GET {base}/datanets                → the datanets this credential can read
//   GET {base}/datanets/{id}/pods?limit=N → up to N pods, each with id/name/text
// with `Authorization: Bearer <REPPO_API_KEY>` (the node's platform agent key)
// and base = EVAL_DATANET_API_URL ?? platformBase(). Lists may arrive bare or
// wrapped (`{ datanets: [...] }` / `{ pods: [...] }` / `{ items }` / `{ data }`).
// Every non-2xx and every unparseable body is a FAILURE (throws → the worker
// :fail-s the job, retryable) — never "no evidence". Non-2xx throws a typed
// DatanetError so the worker can tell a bad credential from an outage.
// Adjust paths/auth/field names here only; nothing outside this file knows the
// wire shape.
import { z } from 'zod'
import { DatanetError, type AccessibleDatanet, type DatanetSource } from './datanet.js'
import type { DatanetPod } from './types.js'

export interface DatanetClientOpts {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const idSchema = z.union([z.number().int(), z.string().min(1)])

const datanetRowSchema = z.object({ id: idSchema, name: z.string().default('') })
const podRowSchema = z.object({ id: idSchema, name: z.string().default(''), text: z.string().default('') })

/** A list endpoint answers either a bare array or one wrapped under a
 *  conventional key — accept both until the docs pin one. */
function unwrapList(body: unknown, keys: string[]): unknown[] | undefined {
  if (Array.isArray(body)) return body
  if (body && typeof body === 'object') {
    for (const k of keys) {
      const v = (body as Record<string, unknown>)[k]
      if (Array.isArray(v)) return v
    }
  }
  return undefined
}

export function makeDatanetClient(opts: DatanetClientOpts): DatanetSource {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 30_000
  const base = opts.baseUrl.replace(/\/+$/, '')

  async function getJson(path: string): Promise<unknown> {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${opts.apiKey}`, accept: 'application/json' },
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
      const rows = unwrapList(await getJson('/datanets'), ['datanets', 'items', 'data'])
      const parsed = z.array(datanetRowSchema).safeParse(rows)
      if (!rows || !parsed.success) throw new Error('datanet api: /datanets response shape mismatch (provisional binding — see datanetClient.ts)')
      return parsed.data.map((d) => ({ datanetId: Number(d.id), name: d.name }))
    },
    async fetchPods(datanetId: number, limit: number): Promise<DatanetPod[]> {
      const path = `/datanets/${encodeURIComponent(String(datanetId))}/pods?limit=${encodeURIComponent(String(limit))}`
      const rows = unwrapList(await getJson(path), ['pods', 'items', 'data'])
      const parsed = z.array(podRowSchema).safeParse(rows)
      if (!rows || !parsed.success) throw new Error(`datanet api: pods response shape mismatch for datanet ${datanetId} (provisional binding — see datanetClient.ts)`)
      return parsed.data.map((p) => ({ datanetId, podId: String(p.id), name: p.name, text: p.text }))
    },
  }
}
