import { describe, expect, it, vi } from 'vitest'
import { InMemoryDatanetSource, cachedSource, type DatanetSource } from './datanet.js'
import type { DatanetPod } from './types.js'

// Datanet ids are subnet cuids on the wire (see datanetClient.ts) — the tests
// use real-shaped ones so nothing here can pass on a numeric id.
const DN_A = 'cms3uejpj0001jf040zjgwqwm'
const DN_B = 'cmnhuowns000bic04e16t6735'
const DN_UNKNOWN = 'cmzzzzzzz0000zz00zzzzzzzz'

const pod = (datanetId: string, podId: string, text = 'x'): DatanetPod => ({ datanetId, podId, name: `pod ${podId}`, text })

describe('InMemoryDatanetSource', () => {
  it('lists the datanets it holds and serves their pods, tagged with the datanet id', async () => {
    const src = new InMemoryDatanetSource([
      { datanetId: DN_A, name: 'perps', pods: [pod(DN_A, '1'), pod(DN_A, '2')] },
      { datanetId: DN_B, name: 'sql', pods: [pod(DN_B, '9')] },
    ])
    expect(await src.listAccessible()).toEqual([
      { datanetId: DN_A, name: 'perps' },
      { datanetId: DN_B, name: 'sql' },
    ])
    expect((await src.fetchPods(DN_B, 10)).map((p) => `${p.datanetId}/${p.podId}`)).toEqual([`${DN_B}/9`])
  })

  it('honours the limit and throws for a datanet it does not hold (unknown ≠ empty)', async () => {
    const src = new InMemoryDatanetSource([{ datanetId: DN_A, name: 'perps', pods: [pod(DN_A, '1'), pod(DN_A, '2'), pod(DN_A, '3')] }])
    expect(await src.fetchPods(DN_A, 2)).toHaveLength(2)
    await expect(src.fetchPods(DN_UNKNOWN, 2)).rejects.toThrow(DN_UNKNOWN)
  })
})

describe('cachedSource', () => {
  const fake = (): DatanetSource & { list: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn> } => {
    const list = vi.fn(async () => [{ datanetId: DN_A, name: 'perps' }])
    const fetch = vi.fn(async (id: string) => [pod(id, 'a')])
    return { list, fetch, listAccessible: list, fetchPods: fetch }
  }

  it('serves listAccessible and per-datanet pods from cache within the TTL', async () => {
    let now = 1_000
    const inner = fake()
    const src = cachedSource(inner, 5_000, () => now)
    await src.listAccessible()
    await src.listAccessible()
    await src.fetchPods(DN_A, 200)
    await src.fetchPods(DN_A, 200)
    expect(inner.list).toHaveBeenCalledTimes(1)
    expect(inner.fetch).toHaveBeenCalledTimes(1)
    now += 5_001
    await src.listAccessible()
    await src.fetchPods(DN_A, 200)
    expect(inner.list).toHaveBeenCalledTimes(2)
    expect(inner.fetch).toHaveBeenCalledTimes(2)
  })

  it('caches per datanet id, not globally', async () => {
    const inner = fake()
    const src = cachedSource(inner, 5_000, () => 0)
    await src.fetchPods(DN_A, 200)
    await src.fetchPods(DN_B, 200)
    expect(inner.fetch).toHaveBeenCalledTimes(2)
    expect(inner.fetch.mock.calls.map((c) => c[0])).toEqual([DN_A, DN_B])
  })

  it('a larger limit than the cached read bypasses the cache (never returns a truncated set as complete)', async () => {
    const inner = fake()
    const src = cachedSource(inner, 5_000, () => 0)
    await src.fetchPods(DN_A, 10)
    await src.fetchPods(DN_A, 200)
    expect(inner.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not cache failures — the next call retries the source', async () => {
    const inner = fake()
    inner.list.mockRejectedValueOnce(new Error('HTTP 503'))
    inner.fetch.mockRejectedValueOnce(new Error('HTTP 503'))
    const src = cachedSource(inner, 5_000, () => 0)
    await expect(src.listAccessible()).rejects.toThrow('HTTP 503')
    await expect(src.fetchPods(DN_A, 1)).rejects.toThrow('HTTP 503')
    expect(await src.listAccessible()).toEqual([{ datanetId: DN_A, name: 'perps' }])
    expect(await src.fetchPods(DN_A, 1)).toHaveLength(1)
    expect(inner.list).toHaveBeenCalledTimes(2)
    expect(inner.fetch).toHaveBeenCalledTimes(2)
  })

  it('concurrent callers share one in-flight read', async () => {
    const inner = fake()
    const src = cachedSource(inner, 5_000, () => 0)
    await Promise.all([src.listAccessible(), src.listAccessible(), src.fetchPods(DN_A, 5), src.fetchPods(DN_A, 5)])
    expect(inner.list).toHaveBeenCalledTimes(1)
    expect(inner.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('cachedSource.invalidate', () => {
  it('drops cached pods so the next read hits the source again (a deleted pod must not be cited twice)', async () => {
    const fetchPods = vi.fn(async () => [{ datanetId: DN_A, podId: 'p', name: 'n', text: 't' }])
    const src = cachedSource({ listAccessible: async () => [{ datanetId: DN_A, name: 'a' }], fetchPods }, 60_000)
    await src.fetchPods(DN_A, 10)
    await src.fetchPods(DN_A, 10)
    expect(fetchPods).toHaveBeenCalledTimes(1)
    src.invalidate?.()
    await src.fetchPods(DN_A, 10)
    expect(fetchPods).toHaveBeenCalledTimes(2)
  })
})
