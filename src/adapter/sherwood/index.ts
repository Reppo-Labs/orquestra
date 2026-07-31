// src/adapter/sherwood/index.ts
import type { LanguageModel } from 'ai'
import { fetchRobinhoodPools, type PoolInfo } from './pools.js'
import { fetchMorphoMarkets, type MorphoMarket } from './morpho.js'
import { synthesizeProposals, type SherwoodStrategy, type ProposalOut } from './proposal.js'
import { filterNovel } from '../dedup.js'
import { filterNovelSemantic } from '../semanticDedup.js'
import { str, num } from '../params.js'
import type { DatanetAdapter, CandidatePod, AdapterContext } from '../types.js'

export interface SherwoodDeps {
  /** Live model resolver, called at each discover() — NOT a model frozen at construction,
   *  so a dashboard default-model change applies on the next cycle without a restart.
   *  undefined ⇒ no LLM (tests inject `generate`; semantic dedup no-ops). */
  getModel?: () => LanguageModel | undefined
  fetchPools?: () => Promise<PoolInfo[]>
  fetchLendingMarkets?: () => Promise<MorphoMarket[]>
  generate?: (args: { system: string; prompt: string }) => Promise<ProposalOut>
  /** Don't hit GeckoTerminal more than once per interval (default 30 min) —
   *  armed only on a successful fetch so a transient failure retries next cycle. */
  minFetchIntervalMs?: number
  /** injectable clock for tests. */
  now?: () => number
}

const STRATEGY_DEFAULTS: SherwoodStrategy = {
  focus: 'executable, risk-coherent strategies on live Robinhood Chain venues',
  brief: '',
  topN: 3,
  minSelfScore: 7,
}
const DEFAULT_MIN_FETCH_INTERVAL_MS = 30 * 60_000
/** Pools thinner than this can't absorb a strategy worth minting about. */
const DEFAULT_MIN_POOL_LIQUIDITY_USD = 10_000

/** Operator-tunable sherwood params, as they arrive on AdapterContext.strategy
 *  (config datanets[id].adapterParams merged with the live brief). */
export interface SherwoodParams extends Partial<SherwoodStrategy> {
  minPoolLiquidityUsd?: number
}

/** Lenient parse of the raw strategy object — validation lives HERE, not in the
 *  wiring: a wrong-typed field (operator-edited config) is dropped so defaults
 *  apply, never crashing discovery or poisoning the synthesis prompt. */
export function parseSherwoodParams(raw: Record<string, unknown> | undefined): SherwoodParams {
  if (!raw) return {}
  const out: SherwoodParams = {}
  const focus = str(raw.focus)
  if (focus !== undefined) out.focus = focus
  const brief = str(raw.brief)
  if (brief !== undefined) out.brief = brief
  const topN = num(raw.topN)
  if (topN !== undefined) out.topN = topN
  const minSelfScore = num(raw.minSelfScore)
  if (minSelfScore !== undefined) out.minSelfScore = minSelfScore
  const minPoolLiquidityUsd = num(raw.minPoolLiquidityUsd)
  if (minPoolLiquidityUsd !== undefined) out.minPoolLiquidityUsd = minPoolLiquidityUsd
  return out
}

/** Sherwood trading-strategy adapter (id "sherwood") — synthesizes proposals for
 *  the Sherwood Trading Strategies datanet on Robinhood Chain from live
 *  GeckoTerminal pool data; personalized per (datanet, operator) via ctx.strategy. */
export function createSherwoodAdapter(deps: SherwoodDeps = {}): DatanetAdapter {
  const fetchPools = deps.fetchPools ?? fetchRobinhoodPools
  const fetchLending = deps.fetchLendingMarkets ?? fetchMorphoMarkets
  const minInterval = deps.minFetchIntervalMs ?? DEFAULT_MIN_FETCH_INTERVAL_MS
  const now = deps.now ?? (() => Date.now())
  // Both upstreams refresh together — one throttle slot; the instance persists
  // across cycles, so the last success time lives in its closure.
  let lastFetchAt: number | undefined
  let lastPools: PoolInfo[] = []
  let lastLending: MorphoMarket[] = []
  return {
    id: 'sherwood',
    async discover(ctx: AdapterContext): Promise<CandidatePod[]> {
      const s = parseSherwoodParams(ctx.strategy)
      const strategy: SherwoodStrategy = {
        ...STRATEGY_DEFAULTS, ...s,
        // operator's adapterParams topN wins, else the cycle's topN, else the default.
        topN: s.topN ?? ctx.topN ?? STRATEGY_DEFAULTS.topN,
      }
      const minLiquidity = s.minPoolLiquidityUsd ?? DEFAULT_MIN_POOL_LIQUIDITY_USD

      // Throttle: within the interval, reuse the last successful pool snapshot
      // instead of skipping the cycle — pool data ages fine over 30 minutes,
      // and proposals depend on the operator brief + novelty as much as prices.
      const t = now()
      let pools: PoolInfo[]
      let lending: MorphoMarket[]
      if (lastFetchAt !== undefined && t - lastFetchAt < minInterval && lastPools.length > 0) {
        pools = lastPools
        lending = lastLending
      } else {
        // A pool-fetch failure (GeckoTerminal 429, network blip) means no
        // candidates THIS cycle — it must not throw into runCycle and mark the
        // datanet errored. Lending data is best-effort ON TOP: without it the
        // prompt drops the Morpho section and the borrow-leg gate switches off.
        try {
          pools = await fetchPools()
        } catch (e) {
          console.error(`orquestra: sherwood pool fetch failed (skipping mint discovery this cycle) — ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
          return []
        }
        lending = await fetchLending().catch((e: unknown) => {
          console.error(`orquestra: sherwood lending fetch failed (proposals go out without borrow-leg data this cycle) — ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
          return []
        })
        lastFetchAt = t // only successful pool fetches arm the throttle
        lastPools = pools
        lastLending = lending
      }

      const liquid = pools.filter((p) => p.reserveUsd >= minLiquidity)
      if (liquid.length === 0) return []

      // Resolve the model LIVE, once per discover — synthesis and semantic dedup share it.
      const model = deps.getModel?.()
      const cands = await synthesizeProposals(liquid, ctx.rubric, ctx.datanetId, strategy, {
        model,
        generate: deps.generate,
      }, lending, ctx.existingPodNames ?? [])
      // Exact-name pre-filter: strategy titles are short (2 significant words),
      // below filterNovel's shared-word floor — an identical title would slip
      // through the overlap backstop and re-mint. Names are the visible dedup
      // surface on the platform, so an exact (case-insensitive) match is out.
      const existingNames = new Set((ctx.existingPodNames ?? []).map((n) => n.trim().toLowerCase()))
      const fresh = cands.filter((c) => !existingNames.has(c.podName.trim().toLowerCase()))
      const novel = filterNovel(fresh, ctx.existingPodNames ?? [])
      const final = await filterNovelSemantic(novel, ctx.existingPodNames ?? [], { model })
      // Zero-mint cycles must explain themselves: candidates that die HERE (not
      // in scoring) were invisible — the cycle just logged "0 mints".
      if (cands.length > 0 && final.length === 0) {
        console.error(`orquestra: sherwood — ${cands.length} proposal(s) dropped as duplicates of existing pods (novelty filters); nothing new to mint this cycle`)
      }
      return final
    },
  }
}
