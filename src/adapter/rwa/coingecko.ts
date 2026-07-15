import type { TokenDailyPoint } from './compare.js'

const isPairRow = (r: unknown): r is [number, number] =>
  Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number'

const toUtcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** Parse CoinGecko /coins/{id}/market_chart JSON into daily points.
 *  Multiple points on one UTC date collapse to the LAST (most recent) one.
 *  Malformed input → [] (caller treats an empty series as a per-pair skip). */
export function parseMarketChart(raw: unknown): TokenDailyPoint[] {
  const prices = (raw as { prices?: unknown })?.prices
  if (!Array.isArray(prices)) return []
  const volumes = (raw as { total_volumes?: unknown })?.total_volumes
  const volByDate = new Map<string, number>()
  if (Array.isArray(volumes)) {
    for (const row of volumes) if (isPairRow(row) && row[1] > 0) volByDate.set(toUtcDate(row[0]), row[1])
  }
  const byDate = new Map<string, TokenDailyPoint>()
  for (const row of prices) {
    if (!isPairRow(row)) continue
    const date = toUtcDate(row[0])
    const vol = volByDate.get(date)
    byDate.set(date, { date, close: row[1], ...(vol !== undefined ? { volumeUsd: vol } : {}) })
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

/** Free, keyless endpoint; ~1 call per pair per cycle (spec request budget). */
export async function fetchTokenDaily(tokenId: string, days: number): Promise<TokenDailyPoint[]> {
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(tokenId)}/market_chart?vs_currency=usd&days=${days}&interval=daily`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`coingecko ${tokenId}: HTTP ${res.status}`)
  return parseMarketChart(await res.json())
}
