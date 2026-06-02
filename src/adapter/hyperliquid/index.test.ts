// src/adapter/hyperliquid/index.test.ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHyperliquidAdapter } from './index.js'
import type { DatanetRubric } from '../../rubric/types.js'

const lb = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/hl-leaderboard.json'), 'utf-8'))
const fills = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/hl-fills.json'), 'utf-8'))
const rubric = { datanetId: '9', name: 'TradingGym AI', canMint: true } as DatanetRubric

describe('hyperliquidAdapter', () => {
  it('matches datanet 9 (tradinggym) and not others', () => {
    const a = createHyperliquidAdapter({ fetchLeaderboard: async () => lb, fetchFills: async () => fills })
    expect(a.id).toBe('hyperliquid')
    expect(a.matches('9', rubric)).toBe(true)
    expect(a.matches('2', { ...rubric, datanetId: '2', name: 'Geopolitics' })).toBe(false)
  })

  it('discover() ranks wallets then builds a candidate per qualifying wallet', async () => {
    const fetchLeaderboard = vi.fn(async () => lb)
    const fetchFills = vi.fn(async () => fills)
    const a = createHyperliquidAdapter({ fetchLeaderboard, fetchFills })
    const cands = await a.discover({ datanetId: '9', rubric, topN: 2 })
    expect(cands.length).toBeGreaterThanOrEqual(1)
    expect(cands[0].podName).toContain('HL perps')
    expect(cands[0].canonicalKey).toMatch(/^[0-9a-f]{16}$/)
    // fetchLeaderboard called exactly once; fetchFills called once per ranked wallet
    expect(fetchLeaderboard).toHaveBeenCalledTimes(1)
    expect(fetchFills).toHaveBeenCalledTimes(2)
  })

  it('discover() continues to next wallet when fetchFills throws for one wallet', async () => {
    let callCount = 0
    const fetchFills = vi.fn(async (_wallet: string) => {
      callCount++
      if (callCount === 1) throw new Error('network error')
      return fills
    })
    const a = createHyperliquidAdapter({ fetchLeaderboard: async () => lb, fetchFills })
    const cands = await a.discover({ datanetId: '9', rubric, topN: 2 })
    expect(cands.length).toBeGreaterThanOrEqual(1)
    expect(cands[0].podName).toContain('HL perps')
  })
})
