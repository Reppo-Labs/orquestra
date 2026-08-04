// src/adapter/sherwood/metrics.test.ts
import { describe, it, expect } from 'vitest'
import { parseMetrics, stdev, fetchPoolMetrics, fetchMetrics, retryAfterMs } from './metrics.js'

const DAY = 86_400
const T0 = 1_785_801_600 // newest candle timestamp (synthetic)

/** Candles oldest-first in the arrays, served newest-first like GeckoTerminal. */
const ohlcv = (closes: number[], vols: number[]): { data: { attributes: { ohlcv_list: unknown[] } } } => {
  const n = closes.length
  const rows = closes.map((c, i) => [T0 - (n - 1 - i) * DAY, c, c, c, c, vols[i]])
  return { data: { attributes: { ohlcv_list: rows.reverse() } } }
}

describe('stdev', () => {
  it('is the sample (n-1) stdev; degenerate inputs are 0', () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3)
    expect(stdev([1])).toBe(0)
    expect(stdev([])).toBe(0)
  })
})

describe('parseMetrics', () => {
  it('computes σ from log returns and trailing volume averages', () => {
    // Constant +1%/day ⇒ constant log return ⇒ σ = 0 (measured, not assumed).
    const closes = Array.from({ length: 15 }, (_, i) => 100 * 1.01 ** i)
    const vols = Array.from({ length: 15 }, () => 1_000_000)
    const m = parseMetrics('0xpool', ohlcv(closes, vols))!
    expect(m).not.toBeNull()
    expect(m.sigma1d).toBeCloseTo(0, 10)
    expect(m.returns).toBe(14)
    expect(m.volAvg7d).toBe(1_000_000)
    expect(m.volAvg14d).toBe(1_000_000)
    expect(m.volTrendRatio).toBe(1)
  })

  it('surfaces a decaying venue as volTrendRatio < 1 (the 7d/14d non-decay input)', () => {
    const closes = Array.from({ length: 15 }, () => 100)
    // Older week busy, recent week dead — the collapse the entry gate must see.
    const vols = [
      ...Array.from({ length: 8 }, () => 10_000_000),
      ...Array.from({ length: 7 }, () => 1_000_000),
    ]
    const m = parseMetrics('0xpool', ohlcv(closes, vols))!
    expect(m.volAvg7d).toBe(1_000_000)
    expect(m.volAvg14d).toBeCloseTo((10_000_000 * 7 + 1_000_000 * 7) / 14, 6)
    expect(m.volTrendRatio).toBeLessThan(0.6)
  })

  it('measures real volatility rather than assuming one', () => {
    const closes = [100, 104, 99, 103, 97, 105, 100, 106, 98, 104, 101, 107, 99, 105, 100]
    const m = parseMetrics('0xpool', ohlcv(closes, closes.map(() => 5)))!
    expect(m.sigma1d).toBeGreaterThan(0.03)
    expect(m.sigma1d).toBeLessThan(0.10)
  })

  it('stamps as_of from the newest candle so no value is a standing property', () => {
    const closes = Array.from({ length: 15 }, () => 100)
    const m = parseMetrics('0xpool', ohlcv(closes, closes.map(() => 1)))!
    expect(m.asOf).toBe(new Date(T0 * 1000).toISOString())
  })

  it('fails closed on a too-short or malformed series rather than guessing', () => {
    const short = Array.from({ length: 4 }, () => 100)
    expect(parseMetrics('0xpool', ohlcv(short, short.map(() => 1)))).toBeNull()
    expect(parseMetrics('0xpool', {})).toBeNull()
    expect(parseMetrics('0xpool', null)).toBeNull()
    expect(parseMetrics('0xpool', { data: { attributes: { ohlcv_list: 'nope' } } })).toBeNull()
  })

  it('drops non-numeric rows and skips returns across a zero close', () => {
    const good = Array.from({ length: 15 }, () => 100)
    const body = ohlcv(good, good.map(() => 1))
    body.data.attributes.ohlcv_list.push(['bad', 1, 1, 1, 1, 1], [T0 + DAY, 1, 1, 1, 0, 1])
    const m = parseMetrics('0xpool', body)!
    expect(m).not.toBeNull()
    // The zero-close candle is kept as a row but contributes no log return.
    expect(m.returns).toBe(14)
  })
})

describe('fetchPoolMetrics', () => {
  const closes = Array.from({ length: 15 }, () => 100)
  const ok = (): Response =>
    ({ ok: true, json: async () => ohlcv(closes, closes.map(() => 7)) }) as unknown as Response

  it('requests daily candles for the pool and parses them', async () => {
    let url = ''
    const fetchImpl = (async (u: string) => { url = u; return ok() }) as unknown as typeof fetch
    const m = await fetchPoolMetrics('0xabc', fetchImpl)
    expect(url).toContain('/networks/robinhood/pools/0xabc/ohlcv/day')
    expect(m?.volAvg7d).toBe(7)
  })

  it('null on HTTP failure and on transport failure — never a default σ', async () => {
    const bad = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch
    expect(await fetchPoolMetrics('0xabc', bad)).toBeNull()
    const boom = (async () => { throw new Error('network') }) as unknown as typeof fetch
    expect(await fetchPoolMetrics('0xabc', boom)).toBeNull()
  })

  it('identifies itself — the API 403s some default agents', async () => {
    let headers: Record<string, string> = {}
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>
      return ok()
    }) as unknown as typeof fetch
    await fetchPoolMetrics('0xabc', fetchImpl)
    expect(headers['user-agent']).toMatch(/orquestra/)
  })
})

describe('retryAfterMs', () => {
  it('floors a short or absent Retry-After — the limiter stays tripped for a while', () => {
    expect(retryAfterMs(null)).toBe(30_000)
    expect(retryAfterMs('2')).toBe(30_000)
    expect(retryAfterMs('garbage')).toBe(30_000)
  })
  it('honors a longer delta-seconds value', () => {
    expect(retryAfterMs('90')).toBe(90_000)
  })
})

describe('fetchMetrics', () => {
  const closes = Array.from({ length: 15 }, () => 100)
  const okBody = () => ({ ok: true, status: 200, json: async () => ohlcv(closes, closes.map(() => 1)) }) as unknown as Response

  it('caps the number of calls and omits pools it could not measure', async () => {
    const calls: string[] = []
    const fetchImpl = (async (u: string) => {
      calls.push(u)
      if (u.includes('0xbad')) return { ok: false, status: 500 } as unknown as Response
      return okBody()
    }) as unknown as typeof fetch
    const out = await fetchMetrics(['0xa', '0xbad', '0xc', '0xd'], { fetchImpl, max: 3, delayMs: 0 })
    expect(calls).toHaveLength(3) // capped
    expect([...out.keys()]).toEqual(['0xa', '0xc']) // unmeasurable pool absent
  })

  it('paces the calls — an unpaced burst is what got every venue throttled out', async () => {
    const waits: number[] = []
    const fetchImpl = (async () => okBody()) as unknown as typeof fetch
    await fetchMetrics(['0xa', '0xb', '0xc'], { fetchImpl, delayMs: 2_100, sleep: async (ms) => { waits.push(ms) } })
    expect(waits).toEqual([2_100, 2_100]) // spacing between, not before, the first
  })

  it('retries a 429 instead of reading throttling as "this pool has no history"', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      if (calls === 1) return { ok: false, status: 429 } as unknown as Response
      return okBody()
    }) as unknown as typeof fetch
    const out = await fetchMetrics(['0xa'], { fetchImpl, delayMs: 0, sleep: async () => {} })
    expect(calls).toBe(2)
    expect(out.get('0xa')?.volAvg7d).toBe(1)
  })

  it('gives up after the retry budget rather than hanging the cycle', async () => {
    let calls = 0
    const fetchImpl = (async () => { calls++; return { ok: false, status: 429 } as unknown as Response }) as unknown as typeof fetch
    const out = await fetchMetrics(['0xa'], { fetchImpl, delayMs: 0, sleep: async () => {} })
    expect(calls).toBe(3) // initial + 2 retries
    expect(out.size).toBe(0)
  })
})
