import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetDbs } from '../dashboard/db.js'
import { readProposals } from './store.js'
import { discoverDatanets } from './discoverDatanets.js'
import { StrategyConfigSchema, type StrategyConfig } from '../config/schema.js'
import type { DatanetSummary } from '../reppo/listDatanets.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-discover-')) })
afterEach(() => { _resetDbs(); rmSync(dir, { recursive: true, force: true }) })

const dn = (over: Partial<DatanetSummary>): DatanetSummary => ({
  id: '9', name: 'TradingGym', status: 'ACTIVE', description: '',
  accessFeeReppo: 50, emissionsPerEpochReppo: 500,
  upVoteVolume: 0, downVoteVolume: 0,
  ...over,
})

const baseCfg = StrategyConfigSchema.parse({
  horizonDays: 7, cadenceHours: 4,
  stake: { lockReppo: 0, lockDurationDays: 30 },
  budget: { voteRateMaxPerCycle: 10, mintReppoMax: 100 },
  datanets: {},
})

const cfg = (datanets: StrategyConfig['datanets'] = {}): StrategyConfig =>
  ({ ...baseCfg, datanets })

const enabledDatanet = { vote: true as const, mint: false as const, strictness: 'balanced' as const, mintMode: 'pin' as const, voteShare: 1 }

describe('discoverDatanets — REPPO emissions', () => {
  it('creates a vote_enable proposal for an emitting datanet not in config', () => {
    discoverDatanets(dir, [dn({})], cfg(), 100)
    const proposals = readProposals(dir)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ datanetId: '9', field: 'vote_enable', toValue: 'true' })
    expect(proposals[0].rationale).toContain('500.00 REPPO/epoch')
  })

  it('skips datanet already vote-enabled in config', () => {
    discoverDatanets(dir, [dn({})], cfg({ '9': enabledDatanet }), 100)
    expect(readProposals(dir)).toHaveLength(0)
  })

  it('skips datanet with zero REPPO emissions and no nativeToken', () => {
    discoverDatanets(dir, [dn({ emissionsPerEpochReppo: 0 })], cfg(), 100)
    expect(readProposals(dir)).toHaveLength(0)
  })

  it('deduplicates — no second proposal when one is already pending', () => {
    discoverDatanets(dir, [dn({})], cfg(), 100)
    discoverDatanets(dir, [dn({})], cfg(), 101)
    expect(readProposals(dir)).toHaveLength(1)
  })
})

describe('discoverDatanets — non-REPPO (nativeToken) emissions', () => {
  const litebeam = dn({
    id: '22', name: 'Litebeam', emissionsPerEpochReppo: 0,
    nativeToken: { symbol: 'LBM', address: '0xabc', decimals: 18 },
  })

  it('creates a vote_enable proposal for a nativeToken datanet', () => {
    discoverDatanets(dir, [litebeam], cfg(), 100)
    const proposals = readProposals(dir)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ datanetId: '22', field: 'vote_enable', toValue: 'true' })
    expect(proposals[0].rationale).toContain('LBM/epoch')
  })

  it('skips nativeToken datanet already vote-enabled', () => {
    discoverDatanets(dir, [litebeam], cfg({ '22': enabledDatanet }), 100)
    expect(readProposals(dir)).toHaveLength(0)
  })

  it('deduplicates nativeToken proposals across epochs', () => {
    discoverDatanets(dir, [litebeam], cfg(), 100)
    discoverDatanets(dir, [litebeam], cfg(), 101)
    expect(readProposals(dir)).toHaveLength(1)
  })

  it('handles nativeToken with blank symbol ("?") without throwing', () => {
    const blankSymbol = dn({ id: '33', emissionsPerEpochReppo: 0, nativeToken: { symbol: '?', address: '0xdef', decimals: 18 } })
    discoverDatanets(dir, [blankSymbol], cfg(), 100)
    const proposals = readProposals(dir)
    expect(proposals).toHaveLength(1)
    expect(proposals[0].rationale).toContain('?/epoch')
  })
})
