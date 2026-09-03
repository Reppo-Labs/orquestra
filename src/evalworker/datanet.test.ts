import { describe, expect, it, vi } from 'vitest'
import { InMemoryDatanetSource, cachedSource, type DatanetSource } from './datanet.js'
import type { DatanetPod } from './types.js'

const pod = (datanetId: number, podId: string, text = 'x'): DatanetPod => ({ datanetId, podId, name: `pod ${podId}`, text })

describe('InMemoryDatanetSource', () => {
  it('lists the datanets it holds and serves their pods, tagged with the datanet id', async () => {
    const src = new InMemoryDatanetSource([
      { datanetId: 27, name: 'perps', pods: [pod(27, '1'), pod(27, '2')] },
      { datanetId: 31, name: 'sql', pods: [pod(31, '9')] },
    ])
    expect(await src.listAccessible()).toEqual([
      { datanetId: 27, name: 'perps' },
      { datanetId: 31, name: 'sql' },
    ])
    expect((await src.fetchPods(31, 10)).map((p) => `${p.datanetId}/${p.podId}`)).toEqual(['31/9'])
  })

  it('honours the limit and throws for a datanet it does not hold (unknown ≠ empty)', async () => {
    const src = new InMemoryDatanetSource([{ datanetId: 27, name: 'perps', pods: [pod(27, '1'), pod(27, '2'), pod(27, '3')] }])
    expect(await src.fetchPods(27, 2)).toHaveLength(2)
    await expect(src.fetchPods(99, 2)).rejects.toThrow(/99/)
  })
})

describe('cachedSource', () => {
  const fake = (): DatanetSource & { list: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn> } => {
    const list = vi.fn(async () => [{ datanetId: 27, name: 'perps' }])
    const fetch = vi.fn(async (id: number) => [pod(id, 'a')])
    return { list, fetch, listAccessible: list, fetchPods: fetch }
  }

  it('serves listAccessible and per-datanet pods from cache within the TTL', async () => {
    let now = 1_000
    const inner = fake()
    const src = cachedSource(inner, 5_000, () => now)
    await src.listAccessible()
    await src.listAccessible()
    await src.fetchPods(27, 200)
    await src.fetchPods(27, 200)
    expect(inner.list).toHaveBeenCalledTimes(1)
    expect(inner.fetch).toHaveBeenCalledTimes(1)
    now += 5_001
    await src.listAccessible()
    await src.fetchPods(27, 200)
    expect(inner.list).toHaveBeenCalledTimes(2)
    expect(inner.fetch).toHaveBeenCalledTimes(2)
  })

  it('caches per datanet id, not globally', async () => {
    const inner = fake()
    const src = cachedSource(inner, 5_000, () => 0)
    await src.fetchPods(27, 200)
    await src.fetchPods(31, 200)
    expect(inner.fetch).toHaveBeenCalledTimes(2)
    expect(inner.fetch.mock.calls.map((c) => c[0])).toEqual([27, 31])
  })

  it('a larger limit than the cached read bypasses the cache (never returns a truncated set as complete)', async () => {
    const inner = fake()
    const src = cachedSource(inner, 5_000, () => 0)
    await src.fetchPods(27, 10)
    await src.fetchPods(27, 200)
    expect(inner.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not cache failures — the next call retries the source', async () => {
    const inner = fake()
    inner.list.mockRejectedValueOnce(new Error('HTTP 503'))
    inner.fetch.mockRejectedValueOnce(new Error('HTTP 503'))
    const src = cachedSource(inner, 5_000, () => 0)
    await expect(src.listAccessible()).rejects.toThrow('HTTP 503')
    await expect(src.fetchPods(27, 1)).rejects.toThrow('HTTP 503')
    expect(await src.listAccessible()).toEqual([{ datanetId: 27, name: 'perps' }])
    expect(await src.fetchPods(27, 1)).toHaveLength(1)
    expect(inner.list).toHaveBeenCalledTimes(2)
    expect(inner.fetch).toHaveBeenCalledTimes(2)
  })

  it('concurrent callers share one in-flight read', async () => {
    const inner = fake()
    const src = cachedSource(inner, 5_000, () => 0)
    await Promise.all([src.listAccessible(), src.listAccessible(), src.fetchPods(27, 5), src.fetchPods(27, 5)])
    expect(inner.list).toHaveBeenCalledTimes(1)
    expect(inner.fetch).toHaveBeenCalledTimes(1)
  })
})
