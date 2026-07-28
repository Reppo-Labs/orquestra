// src/adapter/sherwood/pools.ts
// Live DEX pool data for Robinhood Chain from GeckoTerminal — the feasibility
// ground truth for sherwood strategy proposals (the datanet's voters score
// "venue exists on Robinhood Chain with sufficient liquidity for the stated
// capital range", so candidates must cite real pools, not hallucinated ones).
// Public API, no key; network slug `robinhood` verified live 2026-07-28.

const BASE = 'https://api.geckoterminal.com/api/v2'
const TIMEOUT_MS = 15_000

export interface PoolInfo {
  /** display name, e.g. "WOOD / WETH 0.3%". */
  name: string
  /** pool contract address on Robinhood Chain. */
  address: string
  /** DEX slug from GeckoTerminal (e.g. "sushiswap-robinhood"). */
  dex: string
  reserveUsd: number
  volumeUsd24h: number
}

interface RawPool {
  attributes?: {
    name?: string
    address?: string
    reserve_in_usd?: string
    volume_usd?: { h24?: string }
  }
  relationships?: { dex?: { data?: { id?: string } } }
}

const toNum = (v: string | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Defensive parse of a GeckoTerminal pools page — a malformed row is dropped,
 *  never thrown, so one odd pool can't kill the whole discovery cycle. */
export function parsePools(body: unknown): PoolInfo[] {
  const rows = (body as { data?: RawPool[] })?.data
  if (!Array.isArray(rows)) return []
  const out: PoolInfo[] = []
  for (const r of rows) {
    const a = r?.attributes
    if (!a?.name || !a?.address) continue
    out.push({
      name: a.name,
      address: a.address,
      dex: r.relationships?.dex?.data?.id ?? 'unknown',
      reserveUsd: toNum(a.reserve_in_usd),
      volumeUsd24h: toNum(a.volume_usd?.h24),
    })
  }
  return out
}

/** Fetch the top Robinhood Chain pools (one page, GeckoTerminal default sort).
 *  Throws on transport/HTTP failure — the adapter treats a throw as "no
 *  candidates this cycle", mirroring the gdelt fetch contract. */
export async function fetchRobinhoodPools(fetchImpl: typeof fetch = fetch): Promise<PoolInfo[]> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${BASE}/networks/robinhood/pools?page=1`, {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`)
    return parsePools(await res.json())
  } finally {
    clearTimeout(t)
  }
}
