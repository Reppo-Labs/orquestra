// src/adapter/rwa/index.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createRwaAdapter, parseRwaParams } from './index.js'
import type { TokenDailyPoint, DailyPoint } from './compare.js'
import type { AdapterContext } from '../types.js'

const NOW = Date.UTC(2026, 6, 15, 12)  // 2026-07-15T12:00Z → periodEnd 2026-07-15

// 6 aligned weekdays ending at periodEnd; token has weekend extras.
const refSeries: DailyPoint[] = [
  { date: '2026-07-08', close: 101 }, { date: '2026-07-09', close: 103 },
  { date: '2026-07-10', close: 104 }, { date: '2026-07-13', close: 106 },
  { date: '2026-07-14', close: 105 }, { date: '2026-07-15', close: 107 },
]
const tokenSeries: TokenDailyPoint[] = [
  { date: '2026-07-08', close: 101.5, volumeUsd: 1e6 }, { date: '2026-07-09', close: 103, volumeUsd: 1e6 },
  { date: '2026-07-10', close: 104.5, volumeUsd: 1e6 }, { date: '2026-07-11', close: 104.8, volumeUsd: 1e6 },
  { date: '2026-07-12', close: 105.1, volumeUsd: 1e6 }, { date: '2026-07-13', close: 106.5, volumeUsd: 1e6 },
  { date: '2026-07-14', close: 105.2, volumeUsd: 1e6 }, { date: '2026-07-15', close: 107.3, volumeUsd: 1e6 },
]

const baseCtx = (over: Partial<AdapterContext> = {}): AdapterContext => ({
  datanetId: '25',
  rubric: {} as AdapterContext['rubric'],  // rwa discovery never reads the rubric
  topN: 4,
  ...over,
})

const happyDeps = () => ({
  fetchToken: vi.fn(async () => tokenSeries),
  fetchReference: vi.fn(async () => refSeries),
  now: () => NOW,
  log: vi.fn(),
  sleepFn: async () => {},   // no real pacing delays in tests
})

describe('parseRwaParams', () => {
  it('picks valid fields, drops junk', () => {
    expect(parseRwaParams({ focus: 'gold', topN: 3, periodDays: 10 })).toEqual({ focus: 'gold', topN: 3, periodDays: 10 })
    expect(parseRwaParams({ focus: 42, topN: 'many', periodDays: null })).toEqual({})
    expect(parseRwaParams(undefined)).toEqual({})
  })
})

describe('createRwaAdapter.discover', () => {
  it('emits one pod per pair with spec-shaped dataset', async () => {
    const deps = happyDeps()
    const pods = await createRwaAdapter(deps).discover(baseCtx({ strategy: { focus: 'gold' } }))
    expect(pods).toHaveLength(2)   // paxg-gold + xaut-gold
    const pod = pods[0]!
    expect(pod.podName).toBe('PAXG vs GOLD tracking 2026-07-15')
    expect(pod.podName.length).toBeLessThanOrEqual(50)
    expect(pod.podDescription.length).toBeLessThanOrEqual(200)
    expect(pod.canonicalKey).toHaveLength(16)
    expect(pod.sourceUrl).toBe('https://www.coingecko.com/en/coins/pax-gold')
    const ds = pod.dataset as Record<string, any>
    expect(ds.pair.token).toBe('PAXG')
    expect(ds.period.end).toBe('2026-07-15')
    expect(ds.stats.tradingDaysCompared).toBe(6)
    expect(ds.sources).toHaveLength(2)
    expect(ds.series.token.length).toBeGreaterThan(0)
    expect(pod.selfScore).toBe(8)  // ≥5 days + volume present
  })

  it('canonicalKey is stable for same pair+period, distinct across pairs', async () => {
    const a = await createRwaAdapter(happyDeps()).discover(baseCtx({ strategy: { focus: 'gold' } }))
    const b = await createRwaAdapter(happyDeps()).discover(baseCtx({ strategy: { focus: 'gold' } }))
    expect(a[0]!.canonicalKey).toBe(b[0]!.canonicalKey)
    expect(a[0]!.canonicalKey).not.toBe(a[1]!.canonicalKey)
  })

  it('isolates a failing pair and logs it', async () => {
    const deps = happyDeps()
    deps.fetchToken = vi.fn(async (tokenId: string) => {
      if (tokenId === 'pax-gold') throw new Error('boom 503')
      return tokenSeries
    })
    const pods = await createRwaAdapter(deps).discover(baseCtx({ strategy: { focus: 'gold' } }))
    expect(pods).toHaveLength(1)   // xaut-gold survived
    expect(deps.log.mock.calls.flat().join(' ')).toContain('paxg-gold')
  })

  it('skips already-published pods by name and logs the zero-candidate reason', async () => {
    const deps = happyDeps()
    const pods = await createRwaAdapter(deps).discover(baseCtx({
      strategy: { focus: 'PAXG' },
      existingPodNames: ['PAXG vs GOLD tracking 2026-07-15'],
    }))
    expect(pods).toHaveLength(0)
    expect(deps.log.mock.calls.flat().join(' ')).toContain('already published')
  })

  it('unmatched focus → zero candidates with logged reason, no fetches', async () => {
    const deps = happyDeps()
    const pods = await createRwaAdapter(deps).discover(baseCtx({ strategy: { focus: 'zzz' } }))
    expect(pods).toHaveLength(0)
    expect(deps.fetchToken).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalled()
  })

  it('respects topN (params over ctx)', async () => {
    const pods = await createRwaAdapter(happyDeps()).discover(baseCtx({ strategy: { topN: 1 } }))
    expect(pods).toHaveLength(1)
  })

  it('insufficient shared days → skip with reason', async () => {
    const deps = happyDeps()
    deps.fetchReference = vi.fn(async () => refSeries.slice(0, 1))  // 1 shared day
    const pods = await createRwaAdapter(deps).discover(baseCtx({ strategy: { focus: 'PAXG' } }))
    expect(pods).toHaveLength(0)
    expect(deps.log.mock.calls.flat().join(' ')).toContain('insufficient')
  })

  it('paces with exactly one sleep between two fetched pairs, none before the first', async () => {
    const deps = happyDeps()
    const sleepFn = vi.fn(async () => {})
    deps.sleepFn = sleepFn
    const pods = await createRwaAdapter(deps).discover(baseCtx({ strategy: { focus: 'gold' } }))
    expect(pods).toHaveLength(2)   // paxg-gold + xaut-gold both fetched
    expect(sleepFn).toHaveBeenCalledTimes(1)
  })

  it('does not sleep when the second pair is pre-skipped by existingPodNames', async () => {
    const deps = happyDeps()
    const sleepFn = vi.fn(async () => {})
    deps.sleepFn = sleepFn
    const pods = await createRwaAdapter(deps).discover(baseCtx({
      strategy: { focus: 'gold' },
      existingPodNames: ['XAUT vs GOLD tracking 2026-07-15'],
    }))
    expect(pods).toHaveLength(1)   // only paxg-gold fetched
    expect(deps.fetchToken).toHaveBeenCalledTimes(1)
    expect(sleepFn).not.toHaveBeenCalled()
  })
})
