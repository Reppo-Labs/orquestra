// src/adapter/sherwood/verifyTokens.ts
// On-chain confirmation of the RWA classifier before anything mints against it.
//
// GeckoTerminal token names are API-SUPPLIED text: the indexer's copy of a name,
// not the name. The deterministic classifier for Robinhood tokenized equities is
// the marker in the token contract's own `name()` (live form "NVIDIA • Robinhood
// Token"), so a token GeckoTerminal flags as an RWA is only trusted after one
// read-only `eth_call name()` against the Robinhood Chain RPC agrees. A pod that
// cites a memecoin as a tokenized equity is exactly the kind of wrong-on-arrival
// claim the datanet's voters downvote, so the check runs BEFORE synthesis ever
// sees the flag.
//
// Failure direction is deliberate: verification failure (RPC down, empty
// returndata, marker absent) CLEARS the flag — the pool stays offered, just
// without RWA standing. Fail-open would let an attacker-named token borrow the
// RWA section of the prompt; fail-closed only costs prominence. Every demotion
// is logged, because a silently-degraded flag is indistinguishable from a
// genuine memecoin (degrade-to-neutral must never be silent).
import { rpcCall } from '../../reppo/mintFee.js'
import type { PoolInfo, TokenRef } from './pools.js'
import { TOKENIZED_STOCK_MARKER } from './pools.js'

/** keccak256("name()")[:4] — the ERC20 name selector. */
const NAME_SELECTOR = '0x06fdde03'

/** Decode the return of `name()`: standard ABI string (offset + length + bytes).
 *  Some legacy tokens return a raw bytes32 instead — handled as a fallback.
 *  Returns undefined when the data decodes to nothing usable. */
export function decodeNameReturn(hex: string): string | undefined {
  if (typeof hex !== 'string' || !hex.startsWith('0x') || hex.length <= 2) return undefined
  const data = hex.slice(2)
  const word = (i: number): string => data.slice(i * 64, (i + 1) * 64)
  const utf8 = (h: string): string => Buffer.from(h, 'hex').toString('utf8')
  try {
    if (data.length >= 128) {
      const offset = Number(BigInt('0x' + word(0)))
      // Standard dynamic string: offset word (32), then length word at the offset.
      if (offset === 32) {
        const len = Number(BigInt('0x' + word(1)))
        if (len >= 0 && len <= 256) {
          const bytes = data.slice(128, 128 + len * 2)
          if (bytes.length === len * 2) return utf8(bytes)
        }
      }
    }
    // bytes32 fallback: one word, right-padded with zeros.
    if (data.length === 64) return utf8(data.replace(/(00)+$/, ''))
  } catch {
    /* malformed hex → undefined below */
  }
  return undefined
}

/** One read-only name() call. Throws on transport failure; resolves undefined on
 *  empty returndata (no such function — an EOA or non-ERC20 at that address). */
export async function fetchOnchainName(
  rpcUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const result = await rpcCall(fetchImpl, rpcUrl, 'eth_call', [{ to: token, data: NAME_SELECTOR }, 'latest'])
  if (typeof result !== 'string' || result === '0x' || result === '') return undefined
  return decodeNameReturn(result)
}

export interface VerifyDeps {
  fetchImpl?: typeof fetch
  /** Cross-cycle verdict cache, keyed by lowercased token address. A contract's
   *  name() does not change, so a verdict is final for the process lifetime;
   *  only FAILED calls (undefined verdict) are retried next cycle. */
  cache?: Map<string, boolean>
  log?: (s: string) => void
}

/** Re-check every token the API flagged as a tokenized stock against its own
 *  contract, clearing flags the chain does not confirm. Returns new PoolInfo
 *  objects (inputs are not mutated — the caller caches the fetched snapshot). */
export async function verifyRwaFlagsOnchain(
  pools: PoolInfo[],
  rpcUrl: string,
  deps: VerifyDeps = {},
): Promise<PoolInfo[]> {
  const { fetchImpl = fetch, cache = new Map<string, boolean>(), log = console.error } = deps

  const flagged = new Map<string, TokenRef>()
  for (const p of pools) {
    for (const t of [p.base, p.quote]) {
      if (t?.isTokenizedStock) flagged.set(t.address.toLowerCase(), t)
    }
  }
  const verdicts = new Map<string, boolean>()
  for (const [addr, t] of flagged) {
    const cached = cache.get(addr)
    if (cached !== undefined) {
      verdicts.set(addr, cached)
      continue
    }
    try {
      const name = await fetchOnchainName(rpcUrl, t.address, fetchImpl)
      const ok = name !== undefined && name.includes(TOKENIZED_STOCK_MARKER)
      cache.set(addr, ok) // a real answer from the chain is final either way
      verdicts.set(addr, ok)
      if (!ok) {
        log(
          `orquestra: sherwood RWA check — ${t.symbol} (${t.address}) API-flagged as tokenized stock but ` +
          `on-chain name() ${name === undefined ? 'returned no data' : `is "${name}"`}; treating as non-RWA`,
        )
      }
    } catch (e) {
      // Transport failure proves nothing about the token: demote THIS cycle
      // (fail closed), do not cache, retry next cycle.
      verdicts.set(addr, false)
      log(
        `orquestra: sherwood RWA check — name() call failed for ${t.symbol} (${t.address}), ` +
        `treating as non-RWA this cycle — ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
      )
    }
  }

  const fix = (t: TokenRef | undefined): TokenRef | undefined => {
    if (!t?.isTokenizedStock) return t
    return verdicts.get(t.address.toLowerCase()) ? t : { ...t, isTokenizedStock: false }
  }
  return pools.map((p) => {
    const base = fix(p.base)
    const quote = fix(p.quote)
    return base === p.base && quote === p.quote
      ? p
      : { ...p, ...(base ? { base } : {}), ...(quote ? { quote } : {}) }
  })
}
