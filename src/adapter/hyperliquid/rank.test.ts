// src/adapter/hyperliquid/rank.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rankByMargin } from './rank.js'

const lb = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/hl-leaderboard.json'), 'utf-8'))

describe('rankByMargin', () => {
  it('ranks by pnl/vlm desc, filters vlm < minVlm and non-positive pnl, returns top N addresses', () => {
    const top = rankByMargin(lb, 'week', 2, 100000)
    expect(top).toEqual(['0xAAA', '0xBBB']) // AAA margin ~34.4 > BBB ~18.7; LOWVLM filtered (vlm<100k); LOSS filtered (pnl<0)
  })

  it('returns [] when the leaderboard is empty or malformed', () => {
    expect(rankByMargin({}, 'week', 5, 0)).toEqual([])
    expect(rankByMargin({ leaderboardRows: [] }, 'week', 5, 0)).toEqual([])
  })
})
