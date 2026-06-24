// src/reppo/listDatanets.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDatanetList } from './listDatanets.js'

const raw = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/datanets-list.json'), 'utf-8'))

describe('parseDatanetList', () => {
  it('maps the catalog into compact summaries', () => {
    const list = parseDatanetList(raw)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ id: '9', name: 'TradingGym AI', accessFeeReppo: 50, upVoteVolume: 9668144 })
    expect(list[0].description).toContain('HL perp')
  })
  it('returns [] on malformed input', () => {
    expect(parseDatanetList({})).toEqual([])
    expect(parseDatanetList(null)).toEqual([])
  })
})

describe('parseDatanetList — nativeToken', () => {
  const base = { id: '22', name: 'Litebeam', status: 'ACTIVE', accessFeeREPPO: '0', emissionsPerEpochREPPO: '0', upVoteVolume: '0', downVoteVolume: '0' }
  const wrap = (extra: Record<string, unknown>) => ({ datanets: [{ ...base, ...extra }] })

  it('parses a non-REPPO nativeToken', () => {
    const list = parseDatanetList(wrap({ nativeToken: { symbol: 'LBM', address: '0xabc', decimals: 18 } }))
    expect(list[0].nativeToken).toEqual({ symbol: 'LBM', address: '0xabc', decimals: 18 })
  })

  it('suppresses nativeToken when symbol is REPPO (case-insensitive)', () => {
    const list = parseDatanetList(wrap({ nativeToken: { symbol: 'reppo', address: '0xabc', decimals: 18 } }))
    expect(list[0].nativeToken).toBeUndefined()
  })

  it('suppresses nativeToken when address is empty', () => {
    const list = parseDatanetList(wrap({ nativeToken: { symbol: 'LBM', address: '', decimals: 18 } }))
    expect(list[0].nativeToken).toBeUndefined()
  })

  it('suppresses nativeToken when address is absent', () => {
    const list = parseDatanetList(wrap({ nativeToken: { symbol: 'LBM', decimals: 18 } }))
    expect(list[0].nativeToken).toBeUndefined()
  })

  it('uses "?" symbol when symbol is blank but address is present', () => {
    const list = parseDatanetList(wrap({ nativeToken: { symbol: '', address: '0xabc', decimals: 18 } }))
    expect(list[0].nativeToken).toEqual({ symbol: '?', address: '0xabc', decimals: 18 })
  })

  it('nativeToken is undefined when nativeToken field absent', () => {
    const list = parseDatanetList(wrap({}))
    expect(list[0].nativeToken).toBeUndefined()
  })
})
