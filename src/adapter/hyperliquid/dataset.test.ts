// src/adapter/hyperliquid/dataset.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildHlDataset } from './dataset.js'

const fills = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/hl-fills.json'), 'utf-8'))

describe('buildHlDataset', () => {
  it('builds a candidate with aggregate metrics + a canonical key from a wallet with >=20 closes', () => {
    const c = buildHlDataset('0xWALLET', fills, '9')
    expect(c).not.toBeNull()
    const ds = c!.dataset as { aggregate_metrics: { n_trades: number; win_rate: number; sum_pnl: number } }
    expect(ds.aggregate_metrics.n_trades).toBe(21)
    expect(ds.aggregate_metrics.win_rate).toBeGreaterThan(0)
    expect(c!.canonicalKey).toMatch(/^[0-9a-f]{16}$/)
    expect(c!.podName).toContain('HL perps')
  })

  it('returns null below the 20-closed-trade floor', () => {
    expect(buildHlDataset('0xWALLET', fills.slice(0, 5), '9')).toBeNull()
  })

  it('returns null for an empty / all-unclosed fill set', () => {
    expect(buildHlDataset('0xWALLET', [], '9')).toBeNull()
    expect(buildHlDataset('0xWALLET', [{ coin: 'BTC', px: '1', sz: '1', side: 'B', dir: 'Open Long', closedPnl: '0', time: 1, hash: '0x0' }], '9')).toBeNull()
  })
})
