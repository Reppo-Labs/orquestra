import type { DailyPoint } from './compare.js'

/** Yahoo rejects UA-less requests; a plain browser UA is accepted (Task 0-verified). */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

/** Parse a Yahoo v8 chart payload into daily closes. Null closes (Yahoo emits
 *  them for holidays/in-progress days) and non-positive values are dropped;
 *  duplicate UTC dates collapse to the LAST close; malformed payloads → []. */
export function parseYahooChart(raw: unknown): DailyPoint[] {
  const result = (raw as { chart?: { result?: unknown } })?.chart?.result
  if (!Array.isArray(result) || result.length === 0) return []
  const r = result[0] as { timestamp?: unknown; indicators?: { quote?: Array<{ close?: unknown }> } }
  const ts = r?.timestamp
  const closes = r?.indicators?.quote?.[0]?.close
  if (!Array.isArray(ts) || !Array.isArray(closes)) return []
  const byDate = new Map<string, DailyPoint>()
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]
    const c = closes[i]
    if (typeof t !== 'number' || typeof c !== 'number' || !Number.isFinite(c) || c <= 0) continue
    const date = new Date(t * 1000).toISOString().slice(0, 10)
    byDate.set(date, { date, close: c })
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

/** Free, keyless endpoint serving both gold futures (GC=F) and US equities
 *  (AAPL) — one integration covers both v1 asset classes (spec; Stooq was the
 *  original choice but now serves an anti-bot JS wall — Task 0). */
export async function fetchReferenceDaily(ticker: string, rangeDays: number): Promise<DailyPoint[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${rangeDays}d&interval=1d`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`yahoo ${ticker}: HTTP ${res.status}`)
  return parseYahooChart(await res.json())
}
