// src/dashboard/prices.ts
// USD valuation for the dashboard's per-token PnL flows (GET /api/pnl).
//
// Token addresses are resolved on-chain, never hardcoded per token: REPPO comes
// from networkAddresses(), a datanet's native token (e.g. WOOD) from
// SubnetManager.getSubnetToken via the node's RPC_URL. Spot prices come from
// GeckoTerminal's public simple-price endpoint (same free-tier API the sherwood
// adapter already uses for pool data) — network slug 'base' for Reppo mainnet,
// 'robinhood' for Robinhood Chain; testnet tokens have no market, so no pricing.
//
// Everything degrades to null, never throws: a missing RPC_URL, an unlisted
// token, or a GeckoTerminal outage renders "price unavailable" in the UI while
// the token-unit flows stay correct.
import { getSubnetEmissionInfo } from '../reppo/subnetManager.js'
import { networkAddresses, reppoNetwork } from '../reppo/network.js'
import type { TokenFlow } from './pnl.js'
import type { DatanetYield } from '../voter/yield.js'

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2'
const FETCH_TIMEOUT_MS = 10_000
/** Spot prices are display-grade; refetching more often than this just burns the
 *  free tier (30 calls/min) on dashboard polls. */
const PRICE_TTL_MS = 5 * 60_000
/** After a failed fetch, don't retry before this — the dashboard polls /api/pnl. */
const FAILURE_TTL_MS = 60_000

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** GeckoTerminal network slug for the node's Reppo network; null = no market data. */
const GECKO_SLUG: Record<ReturnType<typeof reppoNetwork>, string | null> = {
  mainnet: 'base',
  testnet: null,
  robinhood: 'robinhood',
}

export interface TokenPnlView extends TokenFlow {
  /** USD spot per token; null when unpriceable (no RPC, no listing, fetch failed). */
  priceUsd: number | null
  /** net × priceUsd; null when priceUsd is. */
  netUsd: number | null
  /** earned × priceUsd; null when priceUsd is. */
  earnedUsd: number | null
  /** spent × priceUsd; null when priceUsd is. This is the leg's cost basis — the
   *  denominator of the percentage return. */
  spentUsd: number | null
}

export interface TokenPnlSummary {
  tokens: TokenPnlView[]
  /** Σ netUsd across all token legs; null when any leg with a nonzero net is unpriced
   *  (a partial dollar total would read as authoritative while missing a leg). */
  netUsd: number | null
  /** Σ spentUsd across all token legs — the cost basis behind `roiPct`; null when any
   *  leg with nonzero spend is unpriced. */
  spentUsd: number | null
  /** Percentage return on spend: netUsd / spentUsd × 100. Null when either input is
   *  null, and null (not Infinity) at zero spend — a node that has earned without
   *  ever spending has no return RATIO to report, only a dollar figure. */
  roiPct: number | null
}

/** netUsd / spentUsd as a percentage, guarding the undefined-at-zero-spend case.
 *  Exported so the same rule prices one token leg and the whole portfolio. */
export function roiPercent(netUsd: number | null, spentUsd: number | null): number | null {
  if (netUsd === null || spentUsd === null || spentUsd <= 0) return null
  return (netUsd / spentUsd) * 100
}

/** Defensive parse of GeckoTerminal's simple-price body →
 *  lowercase address → USD price. Malformed rows are dropped. */
export function parseTokenPrices(body: unknown): Map<string, number> {
  const prices = (body as { data?: { attributes?: { token_prices?: Record<string, unknown> } } })
    ?.data?.attributes?.token_prices
  const out = new Map<string, number>()
  if (!prices || typeof prices !== 'object') return out
  for (const [addr, v] of Object.entries(prices)) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) out.set(addr.toLowerCase(), n)
  }
  return out
}

export interface TokenPricerDeps {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}

/** Stateful pricer: caches resolved token addresses (permanent — a subnet's token
 *  never changes) and USD spots (PRICE_TTL_MS). One instance lives for the server. */
export function createTokenPricer(deps: TokenPricerDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const addressBySymbol = new Map<string, string | null>()
  let priceCache: { at: number; ok: boolean; prices: Map<string, number> } | null = null

  /** symbol → token address on this network; null when unresolvable. */
  async function resolveAddress(symbol: string, economics: Pick<DatanetYield, 'datanetId' | 'nativeTokenSymbol'>[]): Promise<string | null> {
    const cached = addressBySymbol.get(symbol)
    if (cached !== undefined) return cached
    let addr: string | null = null
    if (symbol === 'REPPO') {
      addr = networkAddresses(reppoNetwork(env)).reppoToken
    } else {
      const rpcUrl = (env.RPC_URL ?? env.REPPO_RPC_URL ?? '').trim()
      const datanet = economics.find((e) => e.nativeTokenSymbol === symbol)
      if (rpcUrl && datanet) {
        try {
          const info = await getSubnetEmissionInfo(rpcUrl, datanet.datanetId, { fetchImpl })
          if (info.primaryToken !== ZERO_ADDRESS) addr = info.primaryToken
        } catch {
          // RPC blip — leave uncached so the next poll retries.
          return null
        }
      }
    }
    addressBySymbol.set(symbol, addr)
    return addr
  }

  async function fetchPrices(slug: string, addresses: string[]): Promise<Map<string, number>> {
    if (priceCache && now() - priceCache.at < (priceCache.ok ? PRICE_TTL_MS : FAILURE_TTL_MS)) {
      return priceCache.prices
    }
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetchImpl(
        `${GECKO_BASE}/simple/networks/${slug}/token_price/${addresses.join(',')}`,
        { headers: { accept: 'application/json' }, signal: ctrl.signal },
      )
      if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`)
      const prices = parseTokenPrices(await res.json())
      priceCache = { at: now(), ok: true, prices }
      return prices
    } catch {
      priceCache = { at: now(), ok: false, prices: new Map() }
      return priceCache.prices
    } finally {
      clearTimeout(t)
    }
  }

  /** Attach USD spots to token flows and total them. Never throws. */
  async function priceTokenFlows(
    flows: TokenFlow[],
    economics: Pick<DatanetYield, 'datanetId' | 'nativeTokenSymbol'>[],
  ): Promise<TokenPnlSummary> {
    const slug = GECKO_SLUG[reppoNetwork(env)]
    const addrOf = new Map<string, string>()
    if (slug) {
      for (const f of flows) {
        const addr = await resolveAddress(f.symbol, economics)
        if (addr) addrOf.set(f.symbol, addr.toLowerCase())
      }
    }
    const prices = slug && addrOf.size > 0 ? await fetchPrices(slug, [...addrOf.values()]) : new Map<string, number>()
    const tokens: TokenPnlView[] = flows.map((f) => {
      const addr = addrOf.get(f.symbol)
      const priceUsd = (addr && prices.get(addr)) || null
      return {
        ...f,
        priceUsd,
        netUsd: priceUsd === null ? null : f.net * priceUsd,
        earnedUsd: priceUsd === null ? null : f.earned * priceUsd,
        spentUsd: priceUsd === null ? null : f.spent * priceUsd,
      }
    })
    const blocked = tokens.some((t) => t.net !== 0 && t.netUsd === null)
    const netUsd = blocked ? null : tokens.reduce((s, t) => s + (t.netUsd ?? 0), 0)
    // Spend has its own blocking rule: an unpriced leg that SPENT is a missing
    // slice of the cost basis, which would inflate the percentage return even
    // when every net happens to price.
    const spendBlocked = tokens.some((t) => t.spent !== 0 && t.spentUsd === null)
    const spentUsd = spendBlocked ? null : tokens.reduce((s, t) => s + (t.spentUsd ?? 0), 0)
    return { tokens, netUsd, spentUsd, roiPct: roiPercent(netUsd, spentUsd) }
  }

  return { priceTokenFlows }
}
