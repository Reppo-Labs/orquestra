import { describe, expect, it } from 'vitest'
import { topKRelevant } from './retrieve.js'
import type { CorpusPod } from './types.js'

const pod = (podId: string, name: string, text: string): CorpusPod => ({ podId, name, text })

const corpus: CorpusPod[] = [
  pod('pod:1', 'ETH funding backtest', 'negative funding rate ETH perp entry backtest expectancy'),
  pod('pod:2', 'Cat pictures', 'cats felines whiskers purring'),
  pod('pod:3', 'Hyperliquid stop hunts', 'stop hunt wick behavior liquidation ETH perp'),
  pod('pod:4', 'SQL migrations', 'database migration reversibility data loss'),
]

describe('topKRelevant', () => {
  it('ranks topically relevant pods first', () => {
    const r = topKRelevant('long ETH perp when funding negative with stop', corpus, 2)
    expect(r.map((x) => x.pod.podId)).toEqual(expect.arrayContaining(['pod:1', 'pod:3']))
    expect(r).toHaveLength(2)
  })

  it('returns empty when nothing is relevant', () => {
    const r = topKRelevant('medieval poetry sonnets', corpus)
    expect(r).toEqual([])
  })

  it('returns empty for an empty corpus', () => {
    expect(topKRelevant('anything', [])).toEqual([])
  })

  it('weights rare tokens over ubiquitous ones', () => {
    const c = [
      pod('a', 'x', 'common common common rare-token'),
      pod('b', 'x', 'common common common'),
      pod('c', 'x', 'common'),
    ]
    const r = topKRelevant('rare-token common', c, 1)
    expect(r[0]?.pod.podId).toBe('a')
  })
})
