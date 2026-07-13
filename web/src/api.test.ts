import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchConfig, loadAll, loadHealth, loadModels, runNow, saveStrategy, setPaused } from './api'

const res = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

afterEach(() => { vi.unstubAllGlobals() })

// The WRITE calls must never reject. Every one of them is awaited by a button between
// setBusy(true) and setBusy(false): a rejection skips the reset, and the control — including
// the emergency "stop spending my money" pause — locks on "…" forever with no message while
// the node carries on. An unreachable node is a RESULT, not an exception.
describe('writes never reject — a stranded button is worse than an error', () => {
  const unreachable = () => vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

  it('setPaused reports an unreachable node instead of throwing', async () => {
    unreachable()
    await expect(setPaused(true)).resolves.toMatchObject({ ok: false })
    expect((await setPaused(true)).error).toMatch(/could not reach the node/i)
  })

  it('saveStrategy reports an unreachable node instead of throwing', async () => {
    unreachable()
    const r = await saveStrategy({ datanets: {} })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/could not reach the node/i)
  })

  it('runNow reports an unreachable node instead of throwing', async () => {
    unreachable()
    await expect(runNow()).resolves.toMatchObject({ started: false })
  })

  it('fetchConfig returns null rather than a stale fallback the caller could POST', async () => {
    unreachable()
    expect(await fetchConfig()).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => res(500, { error: 'boom' })))
    expect(await fetchConfig()).toBeNull()
  })

  it('fetchConfig serves the config the node holds RIGHT NOW', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { paused: true, datanets: { '2': { vote: true, mint: false, strictness: 'balanced' } } })))
    expect(await fetchConfig()).toMatchObject({ paused: true })
  })
})

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

describe('loadHealth', () => {
  const report = {
    entriesScanned: 12,
    datanets: [{
      datanetId: '9',
      votes: { executed: 3, refused: 1, error: 1 },
      mints: { executed: 1, refused: 0, error: 0 },
      claims: { executed: 0, refused: 0, error: 0 },
      skips: 2,
      topErrors: [{ code: 'TX_REVERTED', count: 1 }],
      lastSkipReason: 'no rubric',
      idle: false,
      txRate: { executed: 4, failed: 1, rate: 0.8 },
    }],
    txRate: { executed: 4, failed: 1, rate: 0.8 },
  }
  it('passes through a 200 health report', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, report)))
    const out = await loadHealth()
    expect(out?.datanets[0].datanetId).toBe('9')
    expect(out?.datanets[0].txRate?.rate).toBe(0.8)
    expect(out?.datanets[0].topErrors).toEqual([{ code: 'TX_REVERTED', count: 1 }])
  })
  it('carries per-datanet `idle` through — the Health coverage headline is derived from it', async () => {
    const mixed = {
      entriesScanned: 20,
      datanets: [
        { ...report.datanets[0], datanetId: '9', idle: false },
        { ...report.datanets[0], datanetId: '12', idle: true, lastSkipReason: 'no rubric' },
      ],
      txRate: { executed: 8, failed: 0, rate: 1 },
    }
    vi.stubGlobal('fetch', vi.fn(async () => res(200, mixed)))
    const out = await loadHealth()
    // 1 of 2 active — a 100% tx rate must not be readable as "the node is fine".
    expect(out?.datanets.filter((d) => !d.idle)).toHaveLength(1)
    expect(out?.datanets.filter((d) => d.idle)).toHaveLength(1)
    expect(out?.txRate?.rate).toBe(1)
  })
  it('carries per-datanet `idle` through — the Health coverage headline is derived from it', async () => {
    const mixed = {
      entriesScanned: 20,
      datanets: [
        { ...report.datanets[0], datanetId: '9', idle: false },
        { ...report.datanets[0], datanetId: '12', idle: true, lastSkipReason: 'no rubric' },
      ],
      txRate: { executed: 8, failed: 0, rate: 1 },
    }
    vi.stubGlobal('fetch', vi.fn(async () => res(200, mixed)))
    const out = await loadHealth()
    // 1 of 2 active — a 100% tx rate must not be read as "the node is fine".
    expect(out?.datanets.filter((d) => !d.idle)).toHaveLength(1)
    expect(out?.datanets.filter((d) => d.idle)).toHaveLength(1)
    expect(out?.txRate?.rate).toBe(1)
  })
  it('degrades to null on an HTTP error — the Health tab shows unavailable, never crashes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(500, { error: 'boom' })))
    expect(await loadHealth()).toBeNull()
  })
  it('degrades to null on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await loadHealth()).toBeNull()
  })
})

describe('loadHealth', () => {
  const report = {
    entriesScanned: 12,
    datanets: [{
      datanetId: '9',
      votes: { executed: 3, refused: 1, error: 1 },
      mints: { executed: 1, refused: 0, error: 0 },
      claims: { executed: 0, refused: 0, error: 0 },
      skips: 2,
      topErrors: [{ code: 'TX_REVERTED', count: 1 }],
      lastSkipReason: 'no rubric',
      idle: false,
      txRate: { executed: 4, failed: 1, rate: 0.8 },
    }],
    txRate: { executed: 4, failed: 1, rate: 0.8 },
  }
  it('passes through a 200 health report', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, report)))
    const out = await loadHealth()
    expect(out?.datanets[0].datanetId).toBe('9')
    expect(out?.datanets[0].txRate?.rate).toBe(0.8)
    expect(out?.datanets[0].topErrors).toEqual([{ code: 'TX_REVERTED', count: 1 }])
  })
  it('degrades to null on an HTTP error — the Health tab shows unavailable, never crashes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(500, { error: 'boom' })))
    expect(await loadHealth()).toBeNull()
  })
  it('degrades to null on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await loadHealth()).toBeNull()
  })
})

describe('loadModels', () => {
  it('returns the providers array on a 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { providers: [{ provider: 'google', hasKey: true, models: ['gemini-3-pro'] }] })))
    const out = await loadModels()
    expect(out.providers[0].provider).toBe('google')
    expect(out.providers[0].models).toContain('gemini-3-pro')
  })
  it('degrades to an empty providers list on an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(500, { error: 'boom' })))
    expect((await loadModels()).providers).toEqual([])
  })
  it('degrades to an empty providers list on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect((await loadModels()).providers).toEqual([])
  })
})
