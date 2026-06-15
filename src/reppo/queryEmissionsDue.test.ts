import { describe, it, expect } from 'vitest'
import { parseEmissionsDue } from './queryEmissionsDue.js'

describe('parseEmissionsDue', () => {
  // reppo >=0.8.x shape: { totalDueREPPO, byPod: [{ podId, currentEpoch, totalDue, epochs:[{epoch,amount,claimed}] }] }
  it('maps the byPod/epochs shape: one entry per UNCLAIMED epoch', () => {
    const raw = {
      walletAddress: '0xabc',
      totalDueREPPO: { raw: '16500000000000000000', formatted: '16.5' },
      byPod: [
        // amount is a RAW 18-decimal bigint string, exactly as reppo 0.8.4 emits it
        { podId: '987', currentEpoch: 104, totalDue: { raw: '12500000000000000000', formatted: '12.5' },
          epochs: [
            { epoch: 104, amount: '8500000000000000000', claimed: false },   // 8.5 REPPO
            { epoch: 103, amount: '4000000000000000000', claimed: false },   // 4.0 REPPO
            { epoch: 102, amount: '3000000000000000000', claimed: true },    // already claimed → skipped
          ] },
        { podId: '1057', currentEpoch: 105, totalDue: { raw: '4000000000000000000', formatted: '4.0' },
          epochs: [{ epoch: 105, amount: '4000000000000000000', claimed: false }] },
      ],
    }
    const r = parseEmissionsDue(raw)
    expect(r.pods).toEqual([
      { podId: '987', datanetId: '', epoch: 104, reppo: 8.5 },
      { podId: '987', datanetId: '', epoch: 103, reppo: 4.0 },
      { podId: '1057', datanetId: '', epoch: 105, reppo: 4.0 },
    ])
    expect(r.totalReppo).toBeCloseTo(16.5)
  })

  it('byPod with no per-epoch breakdown falls back to the pod-level total at currentEpoch', () => {
    const r = parseEmissionsDue({ byPod: [{ podId: '5', currentEpoch: 104, totalDue: { formatted: '9.0' } }] })
    expect(r.pods).toEqual([{ podId: '5', datanetId: '', epoch: 104, reppo: 9.0 }])
  })

  it('an empty byPod (nothing due) → empty (the live case before an epoch settles)', () => {
    expect(parseEmissionsDue({ walletAddress: '0xabc', totalDueREPPO: { raw: '0', formatted: '0' }, byPod: [] }))
      .toEqual({ totalReppo: 0, pods: [] })
  })

  it('tolerates the legacy <0.8.x { emissions: [...] } shape', () => {
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

  it('drops rows with no podId (both shapes)', () => {
    expect(parseEmissionsDue({ emissions: [{ epoch: 1, amount: { formatted: '5' } }] }).pods).toEqual([])
    expect(parseEmissionsDue({ byPod: [{ currentEpoch: 1, epochs: [{ epoch: 1, amount: '5000000000000000000', claimed: false }] }] }).pods).toEqual([])
  })
})
