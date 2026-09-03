// The evidence port for eval work: which datanets THIS node can read, and
// their pods. The worker grounds every verdict in pods it fetched itself
// through this port — the gateway leases no corpus (eval-datanet-grounding
// design D1). The HTTP binding lives in datanetClient.ts; this file is the
// interface, an in-memory fake for tests, and a TTL cache.
//
// Failure discipline: a source that cannot answer THROWS. An empty list is a
// statement ("this node reads nothing" / "this datanet is empty"), and the
// worker turns it into a denial — so an outage must never be reported as one.
import type { DatanetPod } from './types.js'

export type { DatanetPod } from './types.js'

/** A datanet API rejection carrying its HTTP status. The status is what lets
 *  the worker tell "this node's credentials are wrong" (401/403 — a node
 *  misconfiguration that needs a named cause and a long backoff, exactly like
 *  the gateway lease path) from a transient outage. Lives here, on the port,
 *  not in the HTTP binding: the worker must never import the binding. */
export class DatanetError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DatanetError'
  }
}

export interface AccessibleDatanet {
  datanetId: number
  name: string
}

export interface DatanetSource {
  /** Every datanet this node's credentials can read. */
  listAccessible(): Promise<AccessibleDatanet[]>
  /** Up to `limit` pods of one datanet, each tagged with its datanetId. */
  fetchPods(datanetId: number, limit: number): Promise<DatanetPod[]>
  /** Drop any cached pods (a caching source only). Called when the gateway
   *  rejects a citation as unresolvable: the pod was deleted after we cached
   *  it, and without this every job in the TTL window cites it again and earns
   *  another discard against this node. */
  invalidate?(): void
}

export interface InMemoryDatanet extends AccessibleDatanet {
  pods: DatanetPod[]
}

/** Test/fixture source. Unknown datanet ids throw — mirroring a real API's
 *  404, not an empty datanet. */
export class InMemoryDatanetSource implements DatanetSource {
  constructor(private readonly datanets: InMemoryDatanet[]) {}

  async listAccessible(): Promise<AccessibleDatanet[]> {
    return this.datanets.map(({ datanetId, name }) => ({ datanetId, name }))
  }

  async fetchPods(datanetId: number, limit: number): Promise<DatanetPod[]> {
    const d = this.datanets.find((x) => x.datanetId === datanetId)
    if (!d) throw new Error(`datanet ${datanetId} is not accessible to this source`)
    return d.pods.slice(0, limit)
  }
}

interface Entry<T> {
  value: Promise<T>
  expiresAt: number
  /** For pod reads: the limit the cached read was made with. A later call
   *  asking for MORE must bypass — a truncated set would otherwise read as
   *  the whole datanet for the cache's lifetime. */
  limit: number
}

/** Datanets change slowly (minutes, not per job); one job leases arrive far
 *  more often. Cache listAccessible and each datanet's pods for `ttlMs`.
 *  Failures are never cached: the rejected promise is evicted immediately so
 *  the next job retries the source. Concurrent callers share one in-flight
 *  read (the entry holds the promise, not the value). */
export function cachedSource(source: DatanetSource, ttlMs: number, now: () => number = Date.now): DatanetSource {
  let list: Entry<AccessibleDatanet[]> | undefined
  const pods = new Map<number, Entry<DatanetPod[]>>()

  const fresh = <T>(e: Entry<T> | undefined, limit: number): e is Entry<T> => !!e && e.expiresAt > now() && e.limit >= limit

  return {
    listAccessible() {
      if (fresh(list, 0)) return list.value
      const value = source.listAccessible().catch((err: unknown) => {
        list = undefined
        throw err
      })
      list = { value, expiresAt: now() + ttlMs, limit: 0 }
      return value
    },
    invalidate() {
      // Pods only: the accessible-datanet list is not what went stale.
      pods.clear()
    },
    fetchPods(datanetId, limit) {
      const hit = pods.get(datanetId)
      if (fresh(hit, limit)) return hit.value.then((v) => v.slice(0, limit))
      const value = source.fetchPods(datanetId, limit).catch((err: unknown) => {
        pods.delete(datanetId)
        throw err
      })
      pods.set(datanetId, { value, expiresAt: now() + ttlMs, limit })
      return value
    },
  }
}
