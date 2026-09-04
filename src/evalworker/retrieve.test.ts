import { afterEach, describe, expect, it, vi } from 'vitest'
import { gatherEvidence, topKRelevant } from './retrieve.js'
import { DatanetError, InMemoryDatanetSource } from './datanet.js'
import type { DatanetPod, EvalJobRequest } from './types.js'

// Datanet ids are subnet cuids on the wire (datanetClient.ts).
const DN_A = 'cms3uejpj0001jf040zjgwqwm'
const DN_B = 'cmnhuowns000bic04e16t6735'

const pod = (podId: string, name: string, text: string, datanetId = DN_A): DatanetPod => ({ datanetId, podId, name, text })

const corpus: DatanetPod[] = [
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('gatherEvidence', () => {
  const request: EvalJobRequest = {
    type: 'plan',
    payload: 'Long ETH perp when funding is negative; tight stop under the wick',
    criteria: ['entry historically profitable', 'sizing survives a stop hunt'],
  }

  it('draws candidates from every accessible datanet, each tagged with its datanet id', async () => {
    const source = new InMemoryDatanetSource([
      { datanetId: DN_A, name: 'perps', pods: [pod('482', 'ETH funding backtest', 'negative funding ETH perp backtest expectancy', DN_A)] },
      { datanetId: DN_B, name: 'microstructure', pods: [pod('9', 'Stop hunts', 'stop hunt wick liquidation ETH perp', DN_B), pod('10', 'Cats', 'felines purring', DN_B)] },
    ])
    const out = await gatherEvidence(source, request, 12)
    expect(out.datanetsSearched).toEqual([DN_A, DN_B])
    expect(out.unreadable).toEqual([])
    expect(out.candidates.map((c) => `${c.pod.datanetId}/${c.pod.podId}`).sort()).toEqual([`${DN_A}/482`, `${DN_B}/9`].sort())
  })

  it('bounds the result to k and the per-datanet read to podsPerDatanet', async () => {
    const fetchPods = vi.fn(async (datanetId: string, limit: number) =>
      Array.from({ length: limit }, (_, i) => pod(`p${i}`, 'ETH perp', 'ETH perp funding stop', datanetId)),
    )
    const source = { listAccessible: async () => [{ datanetId: DN_A, name: 'a' }], fetchPods }
    const out = await gatherEvidence(source, request, 3, 50)
    expect(fetchPods).toHaveBeenCalledWith(DN_A, 50)
    expect(out.candidates).toHaveLength(3)
  })

  it('returns zero candidates (not an error) when nothing is relevant, still naming the datanets read', async () => {
    const source = new InMemoryDatanetSource([{ datanetId: DN_A, name: 'perps', pods: [pod('1', 'Cats', 'felines purring', DN_A)] }])
    const out = await gatherEvidence(source, request, 12)
    expect(out.candidates).toEqual([])
    expect(out.datanetsSearched).toEqual([DN_A])
  })

  it('one flaky datanet does not fail the job: keeps what the others answered, names only those', async () => {
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    const source = {
      listAccessible: async () => [
        { datanetId: DN_A, name: 'perps' },
        { datanetId: DN_B, name: 'flaky' },
      ],
      fetchPods: async (datanetId: string) => {
        if (datanetId === DN_B) throw new Error('datanet api HTTP 503')
        return [pod('482', 'ETH funding backtest', 'negative funding ETH perp backtest expectancy', DN_A)]
      },
    }
    const out = await gatherEvidence(source, request, 12)
    expect(out.candidates.map((c) => c.pod.podId)).toEqual(['482'])
    // a denial must never claim a datanet this node never read
    expect(out.datanetsSearched).toEqual([DN_A])
    // the caller must be able to tell "read everything, found nothing" from
    // "could not read the datanet that may hold the evidence"
    expect(out.unreadable).toEqual([DN_B])
    expect(errs.mock.calls.filter((c) => String(c[0]).includes(DN_B))).toHaveLength(1)
  })

  it('propagates a source failure (an outage is never "no evidence")', async () => {
    const source = {
      listAccessible: async () => [{ datanetId: DN_A, name: 'a' }],
      fetchPods: async () => {
        throw new Error('datanet api HTTP 503')
      },
    }
    await expect(gatherEvidence(source, request, 12)).rejects.toThrow('HTTP 503')
    const listFails = {
      listAccessible: async () => {
        throw new Error('datanet api HTTP 401')
      },
      fetchPods: async () => [],
    }
    await expect(gatherEvidence(listFails, request, 12)).rejects.toThrow('HTTP 401')
  })

  it('every datanet failing rethrows the FIRST reason with its DatanetError status intact (auth backoff)', async () => {
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    const source = {
      listAccessible: async () => [
        { datanetId: DN_A, name: 'a' },
        { datanetId: DN_B, name: 'b' },
      ],
      fetchPods: async (datanetId: string) => {
        throw new DatanetError(datanetId === DN_A ? 401 : 503, `datanet api HTTP ${datanetId === DN_A ? 401 : 503}`)
      },
    }
    await expect(gatherEvidence(source, request, 12)).rejects.toMatchObject({ name: 'DatanetError', status: 401 })
    expect(errs).toHaveBeenCalled()
  })
})
