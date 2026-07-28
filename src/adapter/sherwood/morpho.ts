// src/adapter/sherwood/morpho.ts
// Live lending-market data for Robinhood Chain from the Morpho API (GraphQL,
// public, no key — chain 4663 verified indexed 2026-07-28). Morpho Blue
// (0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010 on 4663) is the ONLY lending
// venue on Robinhood Chain today, and its loan side is effectively USDG-only:
// tokenized stocks appear as COLLATERAL (TSLA/SPY/QQQ/… at 62–77% LLTV, SGOV
// to 86–92%), never as the borrowed asset. That asymmetry is load-bearing for
// proposal validation — "borrow a stock token" is not executable on this chain,
// while "collateralize a stock token, borrow USDG" is.
// (Lighter's Robinhood deployment is perps-only, USDG margin — a hedge venue,
// not a lending venue; it has no published API for the Robinhood instance.)

const MORPHO_API = 'https://blue-api.morpho.org/graphql'
const TIMEOUT_MS = 15_000
const CHAIN_ID = 4663

export interface MorphoMarket {
  collateralSymbol: string
  collateralName: string
  loanSymbol: string
  /** liquidation LTV as a fraction (0.77 = 77%). */
  lltv: number
  /** current borrow APY as a fraction (0.032 = 3.2%). */
  borrowApy: number
  /** lendable (unborrowed) liquidity, USD. */
  liquidityUsd: number
  borrowedUsd: number
}

interface RawMarket {
  lltv?: string
  listed?: boolean
  loanAsset?: { symbol?: string | null } | null
  collateralAsset?: { symbol?: string | null; name?: string | null } | null
  state?: {
    borrowApy?: number | null
    liquidityAssetsUsd?: number | null
    borrowAssetsUsd?: number | null
  } | null
}

const QUERY = `{ markets(where:{chainId_in:[${CHAIN_ID}]}, first: 100){ items {
  lltv listed
  loanAsset{symbol} collateralAsset{symbol name}
  state{ borrowApy liquidityAssetsUsd borrowAssetsUsd }
} } }`

/** Defensive parse — unnamed/degenerate rows are dropped, never thrown. */
export function parseMorphoMarkets(body: unknown): MorphoMarket[] {
  const items = (body as { data?: { markets?: { items?: RawMarket[] } } })?.data?.markets?.items
  if (!Array.isArray(items)) return []
  const out: MorphoMarket[] = []
  for (const m of items) {
    const collateralSymbol = m?.collateralAsset?.symbol ?? ''
    const loanSymbol = m?.loanAsset?.symbol ?? ''
    // Rows with unreadable symbols (bytes32/non-standard tokens) are useless
    // in a prompt and unverifiable by voters — drop them.
    if (!collateralSymbol || !loanSymbol) continue
    const lltv = Number(m.lltv ?? 0) / 1e18
    if (!Number.isFinite(lltv) || lltv <= 0) continue
    const s = m.state ?? {}
    out.push({
      collateralSymbol,
      collateralName: m.collateralAsset?.name ?? '',
      loanSymbol,
      lltv,
      borrowApy: s?.borrowApy ?? 0,
      liquidityUsd: s?.liquidityAssetsUsd ?? 0,
      borrowedUsd: s?.borrowAssetsUsd ?? 0,
    })
  }
  return out
}

/** The set of symbols that can actually be BORROWED on Robinhood Chain (loan
 *  assets of markets with real lendable liquidity). Used as the hard gate for
 *  pair strategies' borrowed_asset — practically {USDG} today. */
export function borrowableAssets(markets: MorphoMarket[], minLiquidityUsd = 1_000): Set<string> {
  const out = new Set<string>()
  for (const m of markets) {
    if (m.liquidityUsd >= minLiquidityUsd) out.add(m.loanSymbol.toUpperCase())
  }
  return out
}

/** Fetch Robinhood Chain Morpho markets. Throws on transport/HTTP failure —
 *  the adapter degrades to "no verified lending data this cycle" (prompt drops
 *  the lending section, borrow-leg gate switches off rather than guessing). */
export async function fetchMorphoMarkets(fetchImpl: typeof fetch = fetch): Promise<MorphoMarket[]> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(MORPHO_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`Morpho API HTTP ${res.status}`)
    return parseMorphoMarkets(await res.json())
  } finally {
    clearTimeout(t)
  }
}
