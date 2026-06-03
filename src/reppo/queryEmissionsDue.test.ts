import { describe, it, expect } from 'vitest'
import { parseEmissionsDue } from './queryEmissionsDue.js'

describe('parseEmissionsDue', () => {
  it('maps emissions rows and sums totalReppo', () => {
    const raw = {
      emissions: [
        { podId: '1', datanetId: '9', epoch: 101, amount: { formatted: '12.5' } },
        { podId: '2', subnetId: '9', epoch: 100, amount: { formatted: '4.0' } },
      ],
    }
    const r = parseEmissionsDue(raw)
    expect(r.totalReppo).toBeCloseTo(16.5)
    expect(r.pods).toEqual([
      { podId: '1', datanetId: '9', epoch: 101, reppo: 12.5 },
      { podId: '2', datanetId: '9', epoch: 100, reppo: 4.0 },
    ])
  })

  it('returns empty for missing/garbage input', () => {
    expect(parseEmissionsDue({})).toEqual({ totalReppo: 0, pods: [] })
    expect(parseEmissionsDue(null)).toEqual({ totalReppo: 0, pods: [] })
  })

  it('drops rows with no podId', () => {
    const r = parseEmissionsDue({ emissions: [{ epoch: 1, amount: { formatted: '5' } }] })
    expect(r.pods).toEqual([])
    expect(r.totalReppo).toBe(0)
  })
})
