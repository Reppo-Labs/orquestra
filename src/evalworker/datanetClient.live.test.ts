// NON-HERMETIC: this suite talks to the real Reppo datanet API. It is skipped
// unless DATANET_LIVE is set, so CI stays offline and deterministic.
//
//   DATANET_LIVE=1 npx vitest run src/evalworker/datanetClient.live.test.ts
//
// It exists because a mock can never falsify a vendor's shape: every unit test
// in datanetClient.test.ts asserts the envelope we BELIEVE the API answers,
// and would stay green against a client that cannot read a single real pod.
// That failure already happened once on the gateway side (eval-api), where a
// wrong envelope passed eleven green unit tests. This is the only guard that
// can catch it.
import { describe, expect, it } from 'vitest'
import { makeDatanetClient } from './datanetClient.js'

const LIVE = !!process.env.DATANET_LIVE
const BASE = process.env.EVAL_DATANET_API_URL?.trim() || 'https://reppo.ai/api/v1'
// Sherwood Trading Strategies — a datanet that exists and holds pods.
const SHERWOOD = 'cms3uejpj0001jf040zjgwqwm'
// Well-formed cuid that names no subnet.
const NO_SUCH = 'cmzzzzzzz0000zz00zzzzzzzz'

const client = () => makeDatanetClient({ baseUrl: BASE, timeoutMs: 30_000 })

describe('datanet API (live)', () => {
  it.skipIf(!LIVE)('listAccessible() returns the real subnets, including Sherwood', async () => {
    const nets = await client().listAccessible()
    expect(nets.length).toBeGreaterThanOrEqual(10)
    expect(nets.map((n) => n.datanetId)).toContain(SHERWOOD)
    for (const n of nets) expect(typeof n.datanetId).toBe('string')
  }, 60_000)

  it.skipIf(!LIVE)('fetchPods() returns the whole subnet (never a prefix) and tags every pod with its own datanet', async () => {
    const pods = await client().fetchPods(SHERWOOD)
    // #222: `pods.length > 5` held while the client was reading 20 of 383 rows.
    // Compare against the SERVER's own default page instead: if that page came
    // back full, it is a prefix and the paged read must beat it. Self-calibrating,
    // so a shrinking subnet turns this vacuous loudly (the else branch) not silently.
    const raw = await fetch(`${BASE}/public/pods?filters[subnet]=${SHERWOOD}`).then((r) => r.json() as Promise<{ data: { pods: unknown[] } }>)
    const defaultPage = raw.data.pods.length
    if (pods.length > defaultPage) expect(pods.length).toBeGreaterThan(defaultPage)
    else expect(defaultPage, 'subnet fits in one default page — this case cannot prove paging').toBeLessThan(20)
    for (const p of pods) expect(p.text.length).toBeGreaterThan(0)
    for (const p of pods) {
      expect(p.datanetId).toBe(SHERWOOD)
      expect(p.podId).not.toBe('')
      // Text comes from `description`; the API has no `text` field, so a
      // rename would show up here as empty evidence rather than silently.
      expect(p.text.length).toBeGreaterThan(0)
    }
  }, 60_000)

  it.skipIf(!LIVE)('a subnet cuid that does not exist yields an empty list (probed: 200 with no rows, not a 404)', async () => {
    await expect(client().fetchPods(NO_SUCH)).resolves.toEqual([])
  }, 60_000)
})
