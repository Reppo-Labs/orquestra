import { describe, it, expect, afterEach, vi } from 'vitest'
import { loadAll } from './api'

const res = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

afterEach(() => { vi.unstubAllGlobals() })

describe('loadAll resilience', () => {
  it('coerces a 500 /api/activity (object body) to an empty array — never poisons the Activity tab', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/activity') return res(500, { error: 'sqlite locked' })
      if (url === '/api/pnl') return res(200, { pnl: null, snapshot: null })
      if (url === '/api/config') return res(200, {})
      return res(200, {})
    }))
    const data = await loadAll()
    expect(Array.isArray(data.activity)).toBe(true)
    expect(data.activity).toEqual([])
  })

  it('degrades pnl/config to null/{} on HTTP 500 instead of surfacing the error object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(500, { error: 'boom' })))
    const data = await loadAll()
    expect(data.pnl).toBeNull()
    expect(data.snapshot).toBeNull()
    expect(data.config).toEqual({})
    expect(data.earn).toBeNull()
    expect(data.netNames).toEqual({})
    expect(data.activity).toEqual([])
  })

  it('rejects when the load-critical /api/pnl endpoint is unreachable (so App shows a load error, not a fake fresh node)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(loadAll()).rejects.toThrow()
  })

  it('coerces a 200 whose body is unexpectedly a non-array for activity', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/activity') return res(200, { not: 'an array' })
      return res(200, {})
    }))
    const data = await loadAll()
    expect(data.activity).toEqual([])
  })

  it('passes through valid 200 payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/pnl') return res(200, { pnl: { netReppo: 5 }, snapshot: { ts: 't' } })
      if (url === '/api/activity') return res(200, [{ ts: 't', kind: 'vote' }])
      if (url === '/api/config') return res(200, { horizonDays: 7 })
      if (url === '/api/earn') return res(200, { earning: true })
      if (url === '/api/datanets') return res(200, { '9': 'Hyperliquid' })
      return res(200, {})
    }))
    const data = await loadAll()
    expect(data.pnl).toEqual({ netReppo: 5 })
    expect(data.activity).toHaveLength(1)
    expect(data.config).toEqual({ horizonDays: 7 })
    expect(data.netNames).toEqual({ '9': 'Hyperliquid' })
  })
})
