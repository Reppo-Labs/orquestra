export type AssetClass = 'metal' | 'equity'

export interface RwaPair {
  /** stable registry id, also the canonicalKey component. */
  id: string
  /** CoinGecko coin id (verified in Task 0). */
  tokenId: string
  tokenSymbol: string
  /** Yahoo Finance chart symbol for the real-world reference (verified in Task 0). */
  referenceTicker: string
  /** short display form for pod names (referenceTicker can be ugly, e.g. GC=F). */
  referenceSymbol: string
  referenceName: string
  class: AssetClass
}

/** V1 pairs, all Task 0-verified (EQUITY_ROWS_OK = true). Adding a pair is one
 *  row — no code. Gold reference is COMEX front-month futures (GC=F) — the only
 *  keyless gold daily series Yahoo serves; the dataset method text discloses
 *  the futures-basis caveat. */
export const PAIR_REGISTRY: RwaPair[] = [
  { id: 'paxg-gold', tokenId: 'pax-gold', tokenSymbol: 'PAXG', referenceTicker: 'GC=F', referenceSymbol: 'GOLD', referenceName: 'gold futures (COMEX GC=F)', class: 'metal' },
  { id: 'xaut-gold', tokenId: 'tether-gold', tokenSymbol: 'XAUT', referenceTicker: 'GC=F', referenceSymbol: 'GOLD', referenceName: 'gold futures (COMEX GC=F)', class: 'metal' },
  { id: 'aaplx-aapl', tokenId: 'apple-xstock', tokenSymbol: 'AAPLX', referenceTicker: 'AAPL', referenceSymbol: 'AAPL', referenceName: 'Apple Inc (AAPL)', class: 'equity' },
  { id: 'tslax-tsla', tokenId: 'tesla-xstock', tokenSymbol: 'TSLAX', referenceTicker: 'TSLA', referenceSymbol: 'TSLA', referenceName: 'Tesla Inc (TSLA)', class: 'equity' },
]

const CLASS_ALIASES: Record<string, AssetClass> = {
  metal: 'metal', metals: 'metal', gold: 'metal',
  equity: 'equity', equities: 'equity', stock: 'equity', stocks: 'equity',
}

/** Case-insensitive filter over the registry. Focus terms (comma/space separated)
 *  match a class alias, pair id, token symbol, or a substring of the reference name.
 *  Undefined/empty focus → all pairs. Unmatched terms are simply ignored;
 *  a focus that matches nothing returns [] (caller logs the reason). */
export function filterPairs(pairs: RwaPair[], focus: string | undefined): RwaPair[] {
  const terms = (focus ?? '').toLowerCase().split(/[,\s]+/).filter((t) => t.length > 0)
  if (terms.length === 0) return pairs
  return pairs.filter((p) =>
    terms.some((t) =>
      CLASS_ALIASES[t] === p.class ||
      p.id.toLowerCase() === t ||
      p.tokenSymbol.toLowerCase() === t ||
      p.referenceName.toLowerCase().includes(t),
    ),
  )
}
