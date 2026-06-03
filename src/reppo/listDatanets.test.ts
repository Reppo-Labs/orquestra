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
