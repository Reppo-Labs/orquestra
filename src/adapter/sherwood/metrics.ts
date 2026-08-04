// src/adapter/sherwood/metrics.ts
// Trailing per-pool statistics from GeckoTerminal daily OHLCV — the measured
// inputs every risk number in a sherwood proposal is derived FROM.
//
// Why this exists: a strategy spec is an executable claim about the world, and
// a hardcoded "±3% band" is a claim with no input. Bands are a function of
// realized volatility, entry gates are a function of TRAILING volume, and both
// were previously constants the model invented. A single 24h volume reading is
// also a coin flip on a high-variance series (observed on the nvda/USDG pool:
// $0.65M–$15.5M across 14 days, a 24x spread), so gates must run off trailing
// averages, and a venue whose 7d average has collapsed against its 14d average
// is decaying and must not be offered as an entry at all.
//
// Endpoint shape verified live 2026-08-04:
//   GET /networks/robinhood/pools/{address}/ohlcv/day?aggregate=1&limit=N
//   -> data.attributes.ohlcv_list = [[unixTs, o, h, l, c, volumeUsd], ...]
// newest-first (we sort ascending defensively).

const BASE = 'https://api.geckoterminal.com/api/v2'
const TIMEOUT_MS = 15_000
/** 15 daily candles ⇒ 14 log returns ⇒ a 14d σ and a 14d volume average. */
const DEFAULT_DAYS = 15
/** Below this many returns σ is noise, not a measurement — fail closed. */
const MIN_RETURNS = 5

export interface PoolMetrics {
  address: string
  /** Realized 1-day volatility: stdev of daily log returns, as a fraction (0.0385 = 3.85%). */
  sigma1d: number
  /** Mean daily volume over the trailing 7 candles, USD. */
  volAvg7d: number
  /** Mean daily volume over the trailing 14 candles, USD. */
  volAvg14d: number
  /** volAvg7d / volAvg14d. < 1 means the venue's activity is shrinking. */
  volTrendRatio: number
  /** Log-return samples behind sigma1d — provenance, and the fail-closed input. */
  returns: number
  /** ISO timestamp of the newest candle: the `as_of` for every number here. */
  asOf: string
}

type Candle = [number, number, number, number, number, number]

const isCandle = (r: unknown): r is Candle =>
  Array.isArray(r) && r.length >= 6 && r.slice(0, 6).every((v) => typeof v === 'number' && Number.isFinite(v))

/** Sample standard deviation (n-1). Fewer than 2 samples ⇒ 0. */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length
  const ss = xs.reduce((a, b) => a + (b - mu) ** 2, 0)
  return Math.sqrt(ss / (xs.length - 1))
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

/** Defensive parse of an OHLCV page into metrics. Returns null when the series
 *  is too short or degenerate to measure — the caller must then DROP the pool
 *  rather than substitute a guess (a guessed σ is exactly the defect this
 *  module exists to remove). */
export function parseMetrics(address: string, body: unknown): PoolMetrics | null {
  const raw = (body as { data?: { attributes?: { ohlcv_list?: unknown[] } } })?.data?.attributes?.ohlcv_list
  if (!Array.isArray(raw)) return null
  // Ascending by timestamp; a zero/negative close makes a log return undefined.
  const rows = raw.filter(isCandle).sort((a, b) => a[0] - b[0])
  if (rows.length < MIN_RETURNS + 1) return null

  const returns: number[] = []
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1][4]
    const cur = rows[i][4]
    if (prev > 0 && cur > 0) returns.push(Math.log(cur / prev))
  }
  if (returns.length < MIN_RETURNS) return null

  const vols = rows.map((r) => r[5]).filter((v) => v >= 0)
  const last = (n: number): number[] => vols.slice(Math.max(0, vols.length - n))
  const volAvg7d = mean(last(7))
  const volAvg14d = mean(last(14))
  const newestTs = rows[rows.length - 1][0]

  return {
    address,
    sigma1d: stdev(returns),
    volAvg7d,
    volAvg14d,
    // A pool with no 14d history is not "decaying"; treat the ratio as neutral
    // rather than 0, which would silently disqualify every young venue.
    volTrendRatio: volAvg14d > 0 ? volAvg7d / volAvg14d : 1,
    returns: returns.length,
    asOf: new Date(newestTs * 1000).toISOString(),
  }
}

/** GeckoTerminal's free tier throttles this endpoint hard: measured live
 *  2026-08-04, the THIRD unspaced call returns 429. Unpaced, a burst of ten
 *  leaves eight pools "unmeasurable" — and because the adapter caches a
 *  snapshot for 30 minutes, one throttled burst silently disqualifies every
 *  venue for the whole window. Pace at the documented 30 calls/min. */
const DEFAULT_SPACING_MS = 2_100
/** A 429 is transient and must not be indistinguishable from "this pool has no
 *  history" — the first would wrongly drop a good venue for 30 minutes. */
const RATE_LIMIT_RETRIES = 2
/** Once GeckoTerminal's limiter trips it stays tripped for a while; a few
 *  seconds of backoff just burns the retry budget. Honor `Retry-After` when
 *  the response carries one, and never wait less than this. */
const RATE_LIMIT_FLOOR_MS = 30_000

/** Identify ourselves: the API 403s some default agents outright. */
const UA = 'orquestra-sherwood-adapter/1.0 (+https://github.com/Reppo-Labs/orquestra)'

/** `Retry-After` is upstream-controlled and this sleep runs INSIDE the cycle,
 *  which `runCycle` does not wrap in a timeout — honoring `Retry-After: 86400`
 *  would park the whole node for a day. Waiting longer buys nothing anyway: the
 *  pool is simply left unmeasured and picked up on a later cycle. */
const RATE_LIMIT_CEILING_MS = 60_000

/** `Retry-After` is either delta-seconds or an HTTP date. Bounded at both ends:
 *  a short value wastes the retry budget, a long one hangs the cycle. */
export function retryAfterMs(
  header: string | null,
  floorMs = RATE_LIMIT_FLOOR_MS,
  ceilingMs = RATE_LIMIT_CEILING_MS,
): number {
  const bound = (ms: number): number => Math.min(Math.max(ceilingMs, floorMs), Math.max(floorMs, ms))
  if (!header) return bound(floorMs)
  const secs = Number(header.trim())
  if (Number.isFinite(secs) && secs >= 0) return bound(secs * 1_000)
  const when = Date.parse(header)
  if (Number.isFinite(when)) return bound(when - Date.now())
  return bound(floorMs)
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface FetchMetricsOpts {
  fetchImpl?: typeof fetch
  max?: number
  /** Gap between calls. Tests pass 0. */
  delayMs?: number
  /** Injectable so tests never actually wait. */
  sleep?: (ms: number) => Promise<void>
  /** Stop issuing NEW calls once this much time has elapsed. Measured live,
   *  ten paced calls took 173s because two of them ate a 30s rate-limit floor;
   *  this runs inside a cycle, so the phase needs a hard ceiling rather than an
   *  unbounded worst case. Partial coverage is fine — the caller caches what it
   *  got and measures the rest next cycle. */
  deadlineMs?: number
  /** Injectable clock for the deadline. */
  now?: () => number
}

/** Fetch daily OHLCV metrics for one pool. Returns null when the pool cannot be
 *  measured — metrics are a hard input, so "no metrics" must mean "don't offer
 *  this pool", never "assume a default". Retries a 429 rather than treating
 *  throttling as an absent history. */
export async function fetchPoolMetrics(
  address: string,
  fetchImpl: typeof fetch = fetch,
  days = DEFAULT_DAYS,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  retryBudgetMs = Number.POSITIVE_INFINITY,
): Promise<PoolMetrics | null> {
  // The caller's deadline is only consulted BETWEEN pools, so without a budget
  // here two 30s rate-limit floors on a single pool blow straight through a 45s
  // phase ceiling. Give up on this pool instead of overrunning the cycle.
  let budgetMs = retryBudgetMs
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetchImpl(
        `${BASE}/networks/robinhood/pools/${address}/ohlcv/day?aggregate=1&limit=${days}&currency=usd`,
        { headers: { accept: 'application/json', 'user-agent': UA }, signal: ctrl.signal },
      )
      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        clearTimeout(t)
        const wait = retryAfterMs(res.headers?.get?.('retry-after') ?? null)
        if (wait > budgetMs) return null
        budgetMs -= wait
        await sleep(wait)
        continue
      }
      if (!res.ok) return null
      return parseMetrics(address, await res.json())
    } catch {
      return null
    } finally {
      clearTimeout(t)
    }
  }
  return null
}

/** Fetch metrics for several pools: sequential, capped and PACED. Runs once per
 *  snapshot refresh (every 30 minutes by default), so ~20s of spacing buys a
 *  full set of measured venues instead of two. */
export async function fetchMetrics(
  addresses: string[],
  opts: FetchMetricsOpts = {},
): Promise<Map<string, PoolMetrics>> {
  const {
    fetchImpl = fetch, max = 10, delayMs = DEFAULT_SPACING_MS, sleep = defaultSleep,
    deadlineMs = Number.POSITIVE_INFINITY, now = Date.now,
  } = opts
  const out = new Map<string, PoolMetrics>()
  const targets = addresses.slice(0, max)
  const started = now()
  for (let i = 0; i < targets.length; i++) {
    const remaining = deadlineMs - (now() - started)
    if (remaining <= 0) break
    if (i > 0 && delayMs > 0) await sleep(delayMs)
    // Hand the pool what is left of the phase, so a rate-limit backoff cannot
    // outlive the deadline it is supposed to be bounded by.
    const m = await fetchPoolMetrics(targets[i], fetchImpl, DEFAULT_DAYS, sleep, remaining)
    if (m) out.set(targets[i], m)
  }
  return out
}
