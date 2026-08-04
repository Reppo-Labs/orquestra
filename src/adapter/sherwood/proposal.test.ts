// src/adapter/sherwood/proposal.test.ts
import { describe, it, expect } from 'vitest'
import {
  proposalRejectReason,
  resolveProposal,
  proposalKey,
  proposalDataset,
  synthesizeProposals,
  buildProposalPrompt,
  NON_DECAY_CLAUSE,
  type Proposal,
  type SynthInput,
} from './proposal.js'
import { deriveStrategy, type Venue } from './derive.js'
import type { PoolInfo } from './pools.js'
import type { PoolMetrics } from './metrics.js'
import type { MorphoMarket } from './morpho.js'
import type { DatanetRubric } from '../../rubric/types.js'

const AS_OF = '2026-08-04T00:00:00.000Z'
const rubric = { name: 'Sherwood Trading Strategies', goal: 'g', publisherSpec: 'template', voterRubric: 'v', canMint: true } as DatanetRubric

const woodPool: PoolInfo = {
  name: 'WOOD / WETH 0.3%', address: '0xpool1', dex: 'sushiswap-robinhood',
  reserveUsd: 500_000, volumeUsd24h: 1_000_000,
}
const nvdaPool: PoolInfo = {
  name: 'nvda / USDG 0.05%', address: '0xpool2', dex: 'uniswap-v3-robinhood',
  reserveUsd: 2_000_000, volumeUsd24h: 3_000_000,
  base: { symbol: 'nvda', name: 'NVIDIA (Robinhood Tokenized Stock)', address: '0xnvda', isTokenizedStock: true },
  quote: { symbol: 'USDG', name: 'Global Dollar', address: '0xusdg', isTokenizedStock: false },
}

const metricsFor = (address: string): PoolMetrics => ({
  address, sigma1d: 0.05, volAvg7d: 900_000, volAvg14d: 1_000_000,
  volTrendRatio: 0.9, returns: 14, asOf: '2026-08-03T00:00:00.000Z',
})
const woodVenue: Venue = { pool: woodPool, metrics: metricsFor('0xpool1') }
const nvdaVenue: Venue = { pool: nvdaPool, metrics: metricsFor('0xpool2') }
const venues = [woodVenue, nvdaVenue]

const market: MorphoMarket = {
  marketId: '0xmkt-tsla', collateralSymbol: 'TSLA', collateralName: 'Tesla (Robinhood Tokenized Stock)',
  collateralAddress: '0xtsla', loanSymbol: 'USDG', loanAddress: '0xusdg',
  lltv: 0.77, borrowApy: 0.016, supplyApy: 0.011, liquidityUsd: 50_000, borrowedUsd: 12,
}

const good: Proposal = {
  title: 'WOOD/WETH CL LP',
  strategy_type: 'cl_lp',
  pool_address: '0xpool1',
  vault_asset: 'WOOD',
  thesis: 'Fee capture on the deepest WOOD pool.',
  entry_rule: 'enter when 7d avg volume / TVL exceeds 0.5',
  exit_rule: 'unwind when pool TVL falls below 50% of entry TVL',
  rerange_rule: 'rerange when price exits 80% of the range',
  band_sigma_mult: 1,
  exit_band_mult: 2,
  capital_share_of_tvl: 0.03,
  self_score: 8,
}

const strategy = { focus: 'f', brief: 'b', topN: 3, minSelfScore: 7 }
const input = (over: Partial<SynthInput> = {}): SynthInput =>
  ({ venues, rubric, datanetId: '3', strategy, asOf: AS_OF, ...over })

describe('resolveProposal', () => {
  it('resolves a pool cited by address', () => {
    const r = resolveProposal(good, venues)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.venue.pool.address).toBe('0xpool1')
  })

  it('refuses a venue that is not in the live set — the fabricated-market case', () => {
    const r = resolveProposal({ ...good, pool_address: '0xspusdg-market' }, venues)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/not in this cycle's live pool set/)
  })

  it('refuses a vault_asset that is not a token of the cited pool', () => {
    const r = resolveProposal({ ...good, pool_address: '0xpool2', vault_asset: 'WOOD' }, venues)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/is not a token of pool/)
  })

  it('resolves the borrow market by id and carries it forward', () => {
    const r = resolveProposal(
      { ...good, borrow: { market_id: '0xmkt-tsla', collateral_symbol: 'TSLA', borrowed_asset: 'USDG', ltv_frac_of_lltv: 0.65, exit_ltv_frac_of_lltv: 0.85 } },
      venues,
      [market],
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.market?.marketId).toBe('0xmkt-tsla')
  })

  it('refuses a cited market_id that does not resolve, instead of quietly substituting one', () => {
    // findMarket falls back to the deepest (collateral, loan) pair. That is the
    // right default when no id was cited, but silently swapping in a different
    // market hides the exact error citing-by-id exists to surface.
    const r = resolveProposal(
      { ...good, borrow: { market_id: '0xfabricated', collateral_symbol: 'TSLA', borrowed_asset: 'USDG', ltv_frac_of_lltv: 0.65, exit_ltv_frac_of_lltv: 0.85 } },
      venues,
      [market],
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/cited market_id 0xfabricated does not resolve/)
    expect(r.reason).toContain('0xmkt-tsla') // and names the one it should have cited
  })

  it('still resolves by symbols when no id was cited', () => {
    const r = resolveProposal(
      { ...good, borrow: { collateral_symbol: 'TSLA', borrowed_asset: 'USDG', ltv_frac_of_lltv: 0.65, exit_ltv_frac_of_lltv: 0.85 } },
      venues,
      [market],
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.market?.marketId).toBe('0xmkt-tsla')
  })

  it('refuses a borrowed asset the live lending data does not lend', () => {
    const r = resolveProposal(
      { ...good, borrow: { collateral_symbol: 'TSLA', borrowed_asset: 'NVDA', ltv_frac_of_lltv: 0.65, exit_ltv_frac_of_lltv: 0.85 } },
      venues,
      [market],
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/is not borrowable on Robinhood Chain/)
  })

  it('refuses a borrow leg whose market does not resolve, rather than writing it optimistically', () => {
    const r = resolveProposal(
      { ...good, borrow: { collateral_symbol: 'spUSDG', borrowed_asset: 'USDG', ltv_frac_of_lltv: 0.65, exit_ltv_frac_of_lltv: 0.85 } },
      venues,
      [market],
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/no live Morpho market for collateral spUSDG/)
  })
})

describe('proposalRejectReason', () => {
  it('accepts a deterministic, scale-free proposal', () => {
    expect(proposalRejectReason(good, woodVenue)).toBeNull()
  })
  it('rejects entry rules without a numeric threshold ("buy low" lint)', () => {
    expect(proposalRejectReason({ ...good, entry_rule: 'buy when it looks cheap' })).toMatch(/entry_rule/)
  })
  it('rejects exit rules without a numeric threshold', () => {
    expect(proposalRejectReason({ ...good, exit_rule: 'sell high' })).toMatch(/exit_rule/)
  })
  it('rejects cl_lp without a numeric rerange rule', () => {
    expect(proposalRejectReason({ ...good, rerange_rule: undefined })).toMatch(/rerange_rule/)
    expect(proposalRejectReason({ ...good, rerange_rule: 'rerange when needed' })).toMatch(/rerange_rule/)
  })
  it('rejects a dollar threshold in a rule — an absolute scale is unverifiable', () => {
    expect(proposalRejectReason({ ...good, exit_rule: 'unwind when pool TVL drops below $250000' }))
      .toMatch(/exit_rule states a dollar amount/)
  })
  it('rejects a point-in-time volume gate on a 24x-spread series', () => {
    expect(proposalRejectReason({ ...good, entry_rule: 'enter when 24h volume / TVL exceeds 0.5' }))
      .toMatch(/without a trailing window/)
  })
  it('accepts the same gate expressed as a trailing average', () => {
    expect(proposalRejectReason({ ...good, entry_rule: 'enter when 14d avg volume / TVL exceeds 0.5' })).toBeNull()
  })
  it('requires a session policy on a tokenized-equity venue', () => {
    const rwa = { ...good, pool_address: '0xpool2', vault_asset: 'nvda' }
    expect(proposalRejectReason(rwa, nvdaVenue)).toMatch(/session_policy/)
    expect(proposalRejectReason({ ...rwa, session_policy: 'flatten 30 minutes before the 16:00 ET close; no rerange while closed' }, nvdaVenue))
      .toBeNull()
  })
  it('does not require a session policy on a crypto-only venue', () => {
    expect(proposalRejectReason(good, woodVenue)).toBeNull()
  })
})

describe('proposalKey', () => {
  it('is stable across retitles and thesis edits', () => {
    expect(proposalKey('3', good)).toBe(proposalKey('3', { ...good, title: 'Renamed', thesis: 'different thesis' }))
  })
  it('differs when the strategy identity changes', () => {
    expect(proposalKey('3', good)).not.toBe(proposalKey('3', { ...good, pool_address: '0xpool2' }))
    expect(proposalKey('3', good)).not.toBe(proposalKey('4', good))
  })
})

describe('proposalDataset', () => {
  const derived = deriveStrategy({
    strategyType: 'cl_lp',
    venue: woodVenue,
    policy: { bandSigmaMult: 1, exitBandMult: 2, capitalShareOfTvl: 0.03 },
    asOf: AS_OF,
  })

  it('renders the template fields plus the derivation and evidence blocks', () => {
    expect(derived.ok).toBe(true)
    if (!derived.ok) return
    const d = proposalDataset(good, woodVenue, derived.derived)
    expect(d).toMatchObject({
      kind: 'sherwood-trading-strategy',
      strategy_type: 'cl_lp',
      vault_asset: 'WOOD',
      venue: 'sushiswap-robinhood',
      venue_pool_address: '0xpool1',
    })
    expect((d.risk as { expected_roe_bps: number }).expected_roe_bps).toBeGreaterThan(0)
    expect((d.capital_range_usd as { max: number }).max).toBe(15_000)
    expect(d).toHaveProperty('derivation')
    expect(d).toHaveProperty('evidence')
    expect(d).toHaveProperty('capacity')
    expect(d).not.toHaveProperty('pair')
  })

  it('appends the non-decay entry condition when the model did not state it', () => {
    if (!derived.ok) return
    const d = proposalDataset(good, woodVenue, derived.derived)
    expect(d.entry_rule).toContain(NON_DECAY_CLAUSE)
  })

  it('does not restate the condition when the rule already compares 7d to 14d', () => {
    if (!derived.ok) return
    const already = { ...good, entry_rule: 'enter when 7d avg volume >= 0.8 x 14d avg volume' }
    const d = proposalDataset(already, woodVenue, derived.derived)
    expect(d.entry_rule).toBe(already.entry_rule)
    expect(String(d.entry_rule).match(/14d/g)).toHaveLength(1)
  })
})

describe('synthesizeProposals', () => {
  it('produces candidates whose primary link is the STRATEGY (no sourceUrl → dataset URI), pool as reference', async () => {
    const cands = await synthesizeProposals(input(), { generate: async () => ({ strategies: [good] }) })
    expect(cands).toHaveLength(1)
    expect(cands[0].podName).toBe('WOOD/WETH CL LP')
    expect(cands[0].selfScore).toBe(8)
    expect((cands[0].dataset as { strategy_type: string }).strategy_type).toBe('cl_lp')
    // No sourceUrl: the CLI's Phase 2 then uses the pinned dataset URI as the
    // pod's clickable url (the strategy IS the content on this datanet).
    expect(cands[0].sourceUrl).toBeUndefined()
    expect((cands[0].dataset as { references?: { pool_url?: string } }).references?.pool_url)
      .toBe('https://www.geckoterminal.com/robinhood/pools/0xpool1')
  })

  it('drops proposals below minSelfScore', async () => {
    const cands = await synthesizeProposals(input(), { generate: async () => ({ strategies: [{ ...good, self_score: 5 }] }) })
    expect(cands).toEqual([])
  })

  it('drops non-deterministic proposals before they can cost a mint fee', async () => {
    const cands = await synthesizeProposals(input(), { generate: async () => ({ strategies: [{ ...good, entry_rule: 'enter when it feels right' }] }) })
    expect(cands).toEqual([])
  })

  it('drops a proposal whose venue does not resolve', async () => {
    const cands = await synthesizeProposals(input(), { generate: async () => ({ strategies: [{ ...good, pool_address: '0xghost' }] }) })
    expect(cands).toEqual([])
  })

  it('drops a strategy type whose return has no measurable basis', async () => {
    const cands = await synthesizeProposals(input(), {
      generate: async () => ({ strategies: [{ ...good, strategy_type: 'portfolio' as const, rerange_rule: undefined }] }),
    })
    expect(cands).toEqual([])
  })

  it('a synthesis failure yields [] — never throws into the cycle', async () => {
    const cands = await synthesizeProposals(input(), { generate: async () => { throw new Error('model down') } })
    expect(cands).toEqual([])
  })

  it('empty venues → [] without calling the model', async () => {
    let called = false
    const cands = await synthesizeProposals(input({ venues: [] }), {
      generate: async () => { called = true; return { strategies: [good] } },
    })
    expect(cands).toEqual([])
    expect(called).toBe(false)
  })
})

describe('buildProposalPrompt', () => {
  it('carries the template, operator strategy, and the MEASURED venue list', () => {
    const { system, prompt } = buildProposalPrompt(input())
    expect(system).toMatch(/DETERMINISTIC/)
    expect(system).toMatch(/YOU DO NOT WRITE MEASURED NUMBERS/)
    expect(prompt).toContain('template')
    expect(prompt).toContain('WOOD / WETH 0.3%')
    expect(prompt).toContain('pool_address 0xpool1')
    expect(prompt).toContain('σ_1d 5.00%')
    expect(prompt).toContain('7d/14d 0.90')
    expect(prompt).toContain('Focus: f')
    expect(prompt).toContain(`measured as of ${AS_OF}`)
  })

  it('states the depth cap in dollars for each venue', () => {
    const { prompt } = buildProposalPrompt(input())
    expect(prompt).toContain('max deployable at the 8.00% depth cap: $40,000')
    expect(prompt).toContain('max deployable at the 8.00% depth cap: $160,000')
  })

  it('tags RWA pools and makes the session model mandatory for them', () => {
    const { prompt } = buildProposalPrompt(input())
    expect(prompt).toContain('nvda / USDG 0.05% on uniswap-v3-robinhood [RWA]')
    expect(prompt).toContain('Tokenized equities live on Robinhood Chain')
    expect(prompt).toMatch(/SESSION RISK IS MANDATORY/)
    expect(prompt).toMatch(/never invent a lending market/i)
  })

  it('omits the RWA section when no tokenized equities are present', () => {
    const { prompt } = buildProposalPrompt(input({ venues: [woodVenue] }))
    expect(prompt).not.toContain('Tokenized equities')
  })

  it('lists already-minted pods so the model steers AWAY instead of regenerating them', () => {
    const { prompt } = buildProposalPrompt(input({ existingPodNames: ['NVDA/USDG CL Rerange w/ Morpho USDG Borrow'] }))
    expect(prompt).toContain('Already minted on this datanet')
    expect(prompt).toContain('- NVDA/USDG CL Rerange w/ Morpho USDG Borrow')
  })

  it('omits the already-minted section on an empty datanet', () => {
    expect(buildProposalPrompt(input()).prompt).not.toContain('Already minted')
  })

  it('derives the legal borrowed-asset enum from LIVE lending data, and cites markets by id', () => {
    const markets: MorphoMarket[] = [
      market,
      { ...market, marketId: '0xmkt-weth', collateralSymbol: 'WETH', loanSymbol: 'wUSDX', lltv: 0.9, borrowApy: 0.02, liquidityUsd: 90_000, borrowedUsd: 0 },
    ]
    const { prompt } = buildProposalPrompt(input({ lendingMarkets: markets }))
    // A newly listed Morpho loan asset (wUSDX) appears automatically.
    expect(prompt).toContain('BORROWABLE ASSETS — the ONLY legal values for borrow.borrowed_asset: USDG, WUSDX')
    expect(prompt).toContain('market_id 0xmkt-tsla')
    expect(prompt).toContain('lendable $50,000')
  })

  it('no lending data → no borrowable enum (gate refuses to resolve any market — consistent)', () => {
    const { prompt } = buildProposalPrompt(input())
    expect(prompt).not.toContain('BORROWABLE ASSETS')
  })
})
