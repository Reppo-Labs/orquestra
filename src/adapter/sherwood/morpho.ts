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
  /** Morpho Blue market id (0x…32 bytes) — the concrete identifier a proposal
   *  must carry so the cited market is checkable rather than believable. */
  marketId: string
  collateralSymbol: string
  collateralName: string
  collateralAddress: string
  loanSymbol: string
  loanAddress: string
  /** liquidation LTV as a fraction (0.77 = 77%). */
  lltv: number
  /** current borrow APY as a fraction (0.032 = 3.2%). */
  borrowApy: number
  /** current supply APY as a fraction — the measured yield basis for a
   *  lending_supply strategy (without it its ROE would be a bare constant). */
  supplyApy: number
  /** lendable (unborrowed) liquidity, USD. */
  liquidityUsd: number
  borrowedUsd: number
}

interface RawMarket {
  marketId?: string
  lltv?: string
  listed?: boolean
  loanAsset?: { symbol?: string | null; address?: string | null } | null
  collateralAsset?: { symbol?: string | null; name?: string | null; address?: string | null } | null
  state?: {
    borrowApy?: number | null
    supplyApy?: number | null
    liquidityAssetsUsd?: number | null
    borrowAssetsUsd?: number | null
  } | null
}

// `marketId` is Morpho's per-market identifier on this schema — there is no
// `uniqueKey` field (introspected live 2026-08-04; querying it errors with
// `Cannot query field "uniqueKey" on type "Market"`).
const QUERY = `{ markets(where:{chainId_in:[${CHAIN_ID}]}, first: 100){ items {
  marketId lltv listed
  loanAsset{symbol address} collateralAsset{symbol name address}
  state{ borrowApy supplyApy liquidityAssetsUsd borrowAssetsUsd }
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
      marketId: m.marketId ?? '',
      collateralSymbol,
      collateralName: m.collateralAsset?.name ?? '',
      collateralAddress: m.collateralAsset?.address ?? '',
      loanSymbol,
      loanAddress: m.loanAsset?.address ?? '',
      lltv,
      borrowApy: s?.borrowApy ?? 0,
      supplyApy: s?.supplyApy ?? 0,
      liquidityUsd: s?.liquidityAssetsUsd ?? 0,
      borrowedUsd: s?.borrowAssetsUsd ?? 0,
    })
  }
  return out
}

/** Resolve a market a proposal cites. Matching is by marketId when the model
 *  supplied one, else by (collateral, loan) symbols — and among duplicates the
 *  DEEPEST market wins, because chain 4663 lists several markets for the same
 *  pair at different LLTVs, most with zero liquidity (68 markets live, 7 with
 *  >= $1k lendable; measured 2026-08-04). Returns undefined when nothing
 *  resolves: the caller must then drop the leg, never write it optimistically. */
export function findMarket(
  markets: MorphoMarket[],
  ref: { marketId?: string; collateralSymbol?: string; loanSymbol?: string },
): MorphoMarket | undefined {
  const id = ref.marketId?.trim().toLowerCase()
  if (id) {
    const hit = markets.find((m) => m.marketId.toLowerCase() === id)
    if (hit) return hit
  }
  const col = ref.collateralSymbol?.trim().toUpperCase()
  const loan = ref.loanSymbol?.trim().toUpperCase()
  if (!col || !loan) return undefined
  return markets
    .filter((m) => m.collateralSymbol.toUpperCase() === col && m.loanSymbol.toUpperCase() === loan)
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]
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
