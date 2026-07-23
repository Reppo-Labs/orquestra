import type { AssetClass } from './pairs.js'

/** One daily token observation (CoinGecko side). Canonical definition lives here;
 *  coingecko.ts/stooq.ts import these types so there is a single source of truth. */
export interface TokenDailyPoint { date: string; close: number; volumeUsd?: number }
/** One daily reference observation (Stooq side). */
export interface DailyPoint { date: string; close: number }

export interface CompareStats {
  /** mean of |token − ref| / ref per shared day, in percent. */
  avgTrackingGapPct: number
  /** largest single-day |gap|, in percent. */
  maxDeviationPct: number
  maxDeviationDate: string
  /** mean daily token volume over shared days; null when the source had none. */
  avgDailyTokenVolumeUsd: number | null
  /** equity only: largest |token move| across a reference-market closure (weekend/
   *  holiday), in percent. null for metal class or when no closure in window. */
  closedMarketDriftPct: number | null
  tradingDaysCompared: number
}

interface AlignedDay { date: string; tokenClose: number; refClose: number; volumeUsd?: number }

/** Spec floor: a comparison over fewer shared days is skipped, not published. */
const MIN_SHARED_DAYS = 3
const DAY_MS = 86_400_000

function alignSeries(token: TokenDailyPoint[], reference: DailyPoint[]): AlignedDay[] {
  const ref = new Map(reference.map((p) => [p.date, p.close]))
  return token
    .filter((t) => ref.has(t.date))
    .map((t) => ({
      date: t.date, tokenClose: t.close, refClose: ref.get(t.date)!,
      ...(t.volumeUsd !== undefined ? { volumeUsd: t.volumeUsd } : {}),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

export function compareSeries(
  token: TokenDailyPoint[],
  reference: DailyPoint[],
  assetClass: AssetClass,
): CompareStats | null {
  const days = alignSeries(token, reference)
  if (days.length < MIN_SHARED_DAYS) return null

  let sumAbs = 0
  let maxAbs = -1
  let maxDate = ''
  for (const d of days) {
    const gap = Math.abs(((d.tokenClose - d.refClose) / d.refClose) * 100)
    sumAbs += gap
    if (gap > maxAbs) { maxAbs = gap; maxDate = d.date }
  }

  const vols = days.filter((d) => d.volumeUsd !== undefined).map((d) => d.volumeUsd!)

  // Market-hours handling (the spec's explicit ask): when consecutive SHARED days
  // are >1 calendar day apart, the reference market was closed in between while
  // the token kept trading — report the largest token move across such a closure.
  let drift: number | null = null
  if (assetClass === 'equity') {
    for (let i = 1; i < days.length; i++) {
      const gapDays = (Date.parse(days[i]!.date) - Date.parse(days[i - 1]!.date)) / DAY_MS
      if (gapDays > 1) {
        const move = Math.abs(((days[i]!.tokenClose - days[i - 1]!.tokenClose) / days[i - 1]!.tokenClose) * 100)
        if (drift === null || move > drift) drift = move
      }
    }
  }

  return {
    avgTrackingGapPct: sumAbs / days.length,
    maxDeviationPct: maxAbs,
    maxDeviationDate: maxDate,
    avgDailyTokenVolumeUsd: vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : null,
    closedMarketDriftPct: drift,
    tradingDaysCompared: days.length,
  }
}
