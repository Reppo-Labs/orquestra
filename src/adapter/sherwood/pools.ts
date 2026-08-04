// src/adapter/sherwood/pools.ts
// Live DEX pool data for Robinhood Chain from GeckoTerminal — the feasibility
// ground truth for sherwood strategy proposals (the datanet's voters score
// "venue exists on Robinhood Chain with sufficient liquidity for the stated
// capital range", so candidates must cite real pools, not hallucinated ones).
//
// Token metadata rides along (`include=base_token,quote_token`) so tokenized
// equities are first-class: Robinhood stock tokens are labeled
// "<Name> (Robinhood Tokenized Stock)" in their token name — a deterministic
// classifier, no ticker heuristics (verified live: nvda, spacex; 2026-07-28).
// Public API, no key; network slug `robinhood` verified live 2026-07-28.

const BASE = 'https://api.geckoterminal.com/api/v2'
const TIMEOUT_MS = 15_000
/** GeckoTerminal serves 20 pools/page; 3 pages ≈ the network's active surface
 *  today and stays well under the free tier's 30 calls/min. */
const DEFAULT_PAGES = 3

const TOKENIZED_STOCK_MARKER = '(Robinhood Tokenized Stock)'

export interface TokenRef {
  symbol: string
  name: string
  address: string
  /** Robinhood tokenized equity (RWA), per the token-name marker. */
  isTokenizedStock: boolean
}

export interface PoolInfo {
  /** display name, e.g. "nvda / USDG 0.05%". */
  name: string
  /** pool contract address on Robinhood Chain. */
  address: string
  /** DEX slug from GeckoTerminal (e.g. "uniswap-v3-robinhood"). */
  dex: string
  reserveUsd: number
  volumeUsd24h: number
  base?: TokenRef
  quote?: TokenRef
}

interface RawTokenRow {
  id?: string
  type?: string
  attributes?: { symbol?: string; name?: string; address?: string }
}

interface RawPool {
  attributes?: {
    name?: string
    address?: string
    reserve_in_usd?: string
    volume_usd?: { h24?: string }
  }
  relationships?: {
    dex?: { data?: { id?: string } }
    base_token?: { data?: { id?: string } }
    quote_token?: { data?: { id?: string } }
  }
}

const toNum = (v: string | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function tokenIndex(body: unknown): Map<string, TokenRef> {
  const included = (body as { included?: RawTokenRow[] })?.included
  const map = new Map<string, TokenRef>()
  if (!Array.isArray(included)) return map
  for (const t of included) {
    if (t?.type !== 'token' || !t.id || !t.attributes?.address) continue
    const name = t.attributes.name ?? ''
    map.set(t.id, {
      symbol: t.attributes.symbol ?? '',
      name,
      address: t.attributes.address,
      isTokenizedStock: name.includes(TOKENIZED_STOCK_MARKER),
    })
  }
  return map
}

/** Defensive parse of a GeckoTerminal pools page — a malformed row is dropped,
 *  never thrown, so one odd pool can't kill the whole discovery cycle. */
export function parsePools(body: unknown): PoolInfo[] {
  const rows = (body as { data?: RawPool[] })?.data
  if (!Array.isArray(rows)) return []
  const tokens = tokenIndex(body)
  const out: PoolInfo[] = []
  for (const r of rows) {
    const a = r?.attributes
    if (!a?.name || !a?.address) continue
    const base = tokens.get(r.relationships?.base_token?.data?.id ?? '')
    const quote = tokens.get(r.relationships?.quote_token?.data?.id ?? '')
    out.push({
      name: a.name,
      address: a.address,
      dex: r.relationships?.dex?.data?.id ?? 'unknown',
      reserveUsd: toNum(a.reserve_in_usd),
      volumeUsd24h: toNum(a.volume_usd?.h24),
      ...(base ? { base } : {}),
      ...(quote ? { quote } : {}),
    })
  }
  return out
}

/** A pool whose 24h volume exceeds this multiple of its TVL is a data artifact,
 *  not a venue. Live Robinhood Chain pools sit well under it (the busiest,
 *  USDG/WETH 0.01%, runs ~16x; the meme tail ~40x; measured 2026-08-04). */
export const MAX_VOLUME_TVL_RATIO = 200

/** Input sanity bounds. GeckoTerminal serves degenerate rows — e.g.
 *  "VLAD / GME 1%" with TVL $0 and volume 1.5e28. Any selection rule that
 *  ranks on a COMPUTED RATIO (fee/TVL, volume/TVL) picks that row first, every
 *  time, which turns the price feed into an attack surface against our own
 *  ranker. Bound the inputs before anything ranks on them. */
export function isSanePool(p: PoolInfo): boolean {
  if (!Number.isFinite(p.reserveUsd) || p.reserveUsd <= 0) return false
  if (!Number.isFinite(p.volumeUsd24h) || p.volumeUsd24h < 0) return false
  return p.volumeUsd24h <= p.reserveUsd * MAX_VOLUME_TVL_RATIO
}

/** Drop rows failing the sanity bounds. */
export const sanePools = (pools: PoolInfo[]): PoolInfo[] => pools.filter(isSanePool)

/** Swap fee as a fraction, parsed from the GeckoTerminal pool name suffix
 *  ("nvda / USDG 0.05%" -> 0.0005). Undefined when the name carries no tier —
 *  fee income is then unmeasurable and the pool cannot back a fee-yield claim. */
export function feeTierFromName(name: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*%\s*$/.exec(name.trim())
  if (!m) return undefined
  const pct = Number(m[1])
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return undefined
  return pct / 100
}

/** Unique tokenized-equity tokens present across the fetched pools. */
export function tokenizedStocks(pools: PoolInfo[]): TokenRef[] {
  const seen = new Map<string, TokenRef>()
  for (const p of pools) {
    for (const t of [p.base, p.quote]) {
      if (t?.isTokenizedStock && !seen.has(t.address)) seen.set(t.address, t)
    }
  }
  return [...seen.values()]
}

/** Fetch the top Robinhood Chain pools (multi-page, GeckoTerminal default
 *  sort) with token metadata. Throws on transport/HTTP failure of the FIRST
 *  page — the adapter treats a throw as "no candidates this cycle" (gdelt
 *  contract); later pages are best-effort so a tail-page blip only narrows
 *  coverage instead of dropping the cycle. */
export async function fetchRobinhoodPools(
  fetchImpl: typeof fetch = fetch,
  pages = DEFAULT_PAGES,
): Promise<PoolInfo[]> {
  const fetchPage = async (page: number): Promise<PoolInfo[]> => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetchImpl(
        `${BASE}/networks/robinhood/pools?page=${page}&include=base_token,quote_token`,
        // Identify ourselves: the API 403s some default agents outright.
        {
          headers: {
            accept: 'application/json',
            'user-agent': 'orquestra-sherwood-adapter/1.0 (+https://github.com/Reppo-Labs/orquestra)',
          },
          signal: ctrl.signal,
        },
      )
      if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`)
      return parsePools(await res.json())
    } finally {
      clearTimeout(t)
    }
  }

  const out = await fetchPage(1)
  for (let p = 2; p <= pages; p++) {
    try {
      const next = await fetchPage(p)
      if (next.length === 0) break // past the last page
      out.push(...next)
    } catch {
      break // tail pages are best-effort
    }
  }
  // Dedup by pool address (defensive: pages can shift between requests), then
  // bound the inputs — every downstream consumer ranks or divides by these
  // numbers, so degenerate rows must not survive the fetch boundary.
  const seen = new Set<string>()
  return sanePools(out.filter((p) => (seen.has(p.address) ? false : (seen.add(p.address), true))))
}
