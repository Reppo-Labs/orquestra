// src/adapter/hyperliquid/rank.ts
interface Row { ethAddress: string; windowPerformances?: [string, { pnl: string; vlm: string }][] }

/** Rank leaderboard wallets by margin = pnl/vlm in `window`, biasing toward
 *  directional alpha over churn. Filters vlm < minVlm and non-positive pnl. */
export function rankByMargin(raw: unknown, window: string, topN: number, minVlm: number): string[] {
  const rows = (raw as { leaderboardRows?: Row[] })?.leaderboardRows
  if (!Array.isArray(rows)) return []
  return rows
    .map((r) => {
      const w = r.windowPerformances?.find(([k]) => k === window)?.[1]
      const pnl = Number(w?.pnl ?? '0')
      const vlm = Number(w?.vlm ?? '0')
      return { addr: r.ethAddress, pnl, vlm, margin: vlm > 0 ? pnl / vlm : 0 }
    })
    .filter((x) => x.vlm >= minVlm && x.pnl > 0)
    .sort((a, b) => b.margin - a.margin)
    .slice(0, topN)
    .map((x) => x.addr)
}
