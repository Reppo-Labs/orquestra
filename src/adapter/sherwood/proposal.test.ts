// src/adapter/sherwood/proposal.test.ts
import { describe, it, expect } from 'vitest'
import {
  proposalRejectReason,
  proposalKey,
  proposalDataset,
  synthesizeProposals,
  buildProposalPrompt,
  type Proposal,
} from './proposal.js'
import type { PoolInfo } from './pools.js'
import type { DatanetRubric } from '../../rubric/types.js'

const rubric = { name: 'Sherwood Trading Strategies', goal: 'g', publisherSpec: 'template', voterRubric: 'v', canMint: true } as DatanetRubric

const pools: PoolInfo[] = [
  { name: 'WOOD / WETH 0.3%', address: '0xpool1', dex: 'sushiswap-robinhood', reserveUsd: 500_000, volumeUsd24h: 1_000_000 },
  { name: 'USDG / WETH 0.01%', address: '0xpool2', dex: 'uniswap-robinhood', reserveUsd: 2_000_000, volumeUsd24h: 3_000_000 },
]

const good: Proposal = {
  title: 'WOOD/WETH CL LP ±5%',
  strategy_type: 'cl_lp',
  vault_asset: 'WOOD',
  venue: 'SushiSwap',
  pair: { borrowed_asset: 'WETH', borrow_venue: 'Lighter' },
  thesis: 'Fee capture on the deepest WOOD pool.',
  entry_rule: 'enter when 24h volume / TVL exceeds 0.5',
  exit_rule: 'unwind when pool TVL drops below $250000',
  rerange_rule: 'rerange to ±5% when price exits 80% of the range',
  max_drawdown_bps: 800,
  expected_roe_bps: 2500,
  capital_range_usd: { min: 10_000, max: 100_000 },
  self_score: 8,
}

const strategy = { focus: 'f', brief: 'b', topN: 3, minSelfScore: 7 }

describe('proposalRejectReason', () => {
  it('accepts a deterministic proposal', () => {
    expect(proposalRejectReason(good)).toBeNull()
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
  it('non-cl_lp needs no rerange rule', () => {
    expect(proposalRejectReason({ ...good, strategy_type: 'lending_supply', rerange_rule: undefined })).toBeNull()
  })
  it('rejects an inverted capital band', () => {
    expect(proposalRejectReason({ ...good, capital_range_usd: { min: 100_000, max: 10_000 } })).toMatch(/capital_range/)
  })
})

describe('proposalKey', () => {
  it('is stable across retitles and thesis edits', () => {
    const a = proposalKey('3', good)
    const b = proposalKey('3', { ...good, title: 'Renamed', thesis: 'different thesis' })
    expect(a).toBe(b)
  })
  it('differs when the strategy identity changes', () => {
    expect(proposalKey('3', good)).not.toBe(proposalKey('3', { ...good, venue: 'Uniswap' }))
    expect(proposalKey('3', good)).not.toBe(proposalKey('4', good))
  })
})

describe('proposalDataset', () => {
  it('renders every template field, omitting absent optionals', () => {
    const d = proposalDataset({ ...good, pair: undefined, rerange_rule: undefined })
    expect(d).toMatchObject({
      kind: 'sherwood-trading-strategy',
      strategy_type: 'cl_lp',
      vault_asset: 'WOOD',
      venue: 'SushiSwap',
      risk: { max_drawdown_bps: 800, expected_roe_bps: 2500 },
      capital_range_usd: { min: 10_000, max: 100_000 },
    })
    expect(d).not.toHaveProperty('pair')
    expect(d).not.toHaveProperty('rerange_rule')
  })
})

describe('synthesizeProposals', () => {
  it('produces candidates with stable keys, template dataset, and pool source link', async () => {
    const cands = await synthesizeProposals(pools, rubric, '3', strategy, {
      generate: async () => ({ strategies: [good] }),
    })
    expect(cands).toHaveLength(1)
    expect(cands[0].podName).toBe('WOOD/WETH CL LP ±5%')
    expect(cands[0].selfScore).toBe(8)
    expect((cands[0].dataset as { strategy_type: string }).strategy_type).toBe('cl_lp')
    expect(cands[0].sourceUrl).toBe('https://www.geckoterminal.com/robinhood/pools/0xpool1')
  })
  it('drops proposals below minSelfScore', async () => {
    const cands = await synthesizeProposals(pools, rubric, '3', strategy, {
      generate: async () => ({ strategies: [{ ...good, self_score: 5 }] }),
    })
    expect(cands).toEqual([])
  })
  it('drops non-deterministic proposals before they can cost a mint fee', async () => {
    const cands = await synthesizeProposals(pools, rubric, '3', strategy, {
      generate: async () => ({ strategies: [{ ...good, entry_rule: 'enter when it feels right' }] }),
    })
    expect(cands).toEqual([])
  })
  it('a synthesis failure yields [] — never throws into the cycle', async () => {
    const cands = await synthesizeProposals(pools, rubric, '3', strategy, {
      generate: async () => { throw new Error('model down') },
    })
    expect(cands).toEqual([])
  })
  it('empty pools → [] without calling the model', async () => {
    let called = false
    const cands = await synthesizeProposals([], rubric, '3', strategy, {
      generate: async () => { called = true; return { strategies: [good] } },
    })
    expect(cands).toEqual([])
    expect(called).toBe(false)
  })
})

describe('buildProposalPrompt', () => {
  it('carries the template, operator strategy, and the live pool list', () => {
    const { system, prompt } = buildProposalPrompt(pools, rubric, strategy)
    expect(system).toMatch(/DETERMINISTIC/)
    expect(prompt).toContain('template')
    expect(prompt).toContain('WOOD / WETH 0.3%')
    expect(prompt).toContain('sushiswap-robinhood')
    expect(prompt).toContain('Focus: f')
  })
})
