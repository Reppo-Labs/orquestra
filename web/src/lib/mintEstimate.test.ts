import { describe, expect, it } from 'vitest'
import { buildMintEstimate } from './mintEstimate'
import type { DatanetPnl, Snapshot } from '../api'

// The single rule: a number is either SOURCED or UNKNOWN. It is never 0, and it is never a
// guess — enabling minting spends the operator's real money, and "0" is precisely the answer
// that would make them click the button they should not click.

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  ts: Date.parse('2026-07-12T12:00:00.000Z'),
  balance: { reppo: 2000, veReppo: 0 },
  emissionsDue: { pods: [] },
  budget: {
    mintReppoSpent: 215, voteGasSpentEth: 0, mintGasSpentEth: 0, claimGasSpentEth: 0,
    caps: { mintReppoMax: 3000, mintRateMaxPerCycle: 4 },
  },
  ...over,
})

const dn = (over: Partial<DatanetPnl> = {}): DatanetPnl => ({
  datanetId: '9', reppoSpent: 620, reppoEarned: 0.03, net: -619.97, roi: 0,
  votesCast: 34, mintsExecuted: 124, ...over,
})

describe('the access fee is UNKNOWN, and says why', () => {
  // It exists in the backend (src/reppo/listDatanets.ts → accessFeeReppo) but /api/datanets
  // serves only an id→name map, so it cannot reach the dashboard. Rendering 0 would be a lie
  // that costs real money — and this fee is NOT covered by the budget caps.
  it('never fabricates the one-time access fee, on any input', () => {
    const e = buildMintEstimate({ datanetId: '9', snapshot: snap(), datanetPnl: [dn()] })
    expect(e.accessFee.known).toBe(false)
    if (!e.accessFee.known) expect(e.accessFee.why).toMatch(/does not report/i)
    expect(JSON.stringify(e.accessFee)).not.toContain('"value"')
  })
})

describe('the mint fee comes from what THIS datanet actually charged', () => {
  it("averages the node's real, lifetime mints on this datanet", () => {
    const e = buildMintEstimate({ datanetId: '9', snapshot: snap(), datanetPnl: [dn({ reppoSpent: 620, mintsExecuted: 124 })] })
    expect(e.mintFee).toEqual({ known: true, value: 5, basis: 'average of the 124 mints this node has paid for here' })
  })

  it('is UNKNOWN — never 0 — for a datanet this node has never minted on', () => {
    const e = buildMintEstimate({ datanetId: '17', snapshot: snap(), datanetPnl: [dn({ datanetId: '17', reppoSpent: 0, mintsExecuted: 0 })] })
    expect(e.mintFee.known).toBe(false)
    if (!e.mintFee.known) expect(e.mintFee.why).toMatch(/never minted here/i)
  })

  it('is UNKNOWN for a datanet with no P&L row at all', () => {
    expect(buildMintEstimate({ datanetId: '99', snapshot: snap(), datanetPnl: [] }).mintFee.known).toBe(false)
  })

  it("offers other datanets' fees only as a labelled RANGE, never as this datanet's price", () => {
    // Real fees differ by an order of magnitude (5 vs ~186 REPPO), so a cross-datanet average
    // would be a fabrication dressed as a number.
    const e = buildMintEstimate({
      datanetId: '17',
      snapshot: snap(),
      datanetPnl: [
        dn({ datanetId: '9', reppoSpent: 620, mintsExecuted: 124 }), // 5
        dn({ datanetId: '11', reppoSpent: 5200, mintsExecuted: 28 }), // ~185.7
      ],
    })
    expect(e.mintFee.known).toBe(false) // still unknown FOR THIS DATANET
    expect(e.otherDatanets).toEqual({ min: 5, max: 5200 / 28, count: 2 })
  })

  it('has no range to offer when the node has never minted anywhere', () => {
    expect(buildMintEstimate({ datanetId: '9', snapshot: snap(), datanetPnl: [] }).otherDatanets).toBeNull()
  })
})

describe('the per-cycle worst case', () => {
  it('multiplies the observed fee by the node-wide per-cycle mint cap', () => {
    const e = buildMintEstimate({ datanetId: '9', snapshot: snap(), datanetPnl: [dn()] })
    expect(e.perCycleMax.known).toBe(true)
    if (e.perCycleMax.known) {
      expect(e.perCycleMax.value).toBe(20) // 5 REPPO × 4 mints
      expect(e.perCycleMax.basis).toMatch(/node-wide cap/i)
    }
  })

  it('is UNKNOWN when the fee is unknown — a cap times an unknown is still unknown', () => {
    const e = buildMintEstimate({ datanetId: '17', snapshot: snap(), datanetPnl: [] })
    expect(e.perCycleMax.known).toBe(false)
    if (!e.perCycleMax.known) expect(e.perCycleMax.why).toMatch(/fee for this datanet is unknown/i)
  })

  it('is UNKNOWN when the node reports no per-cycle cap', () => {
    const s = snap({ budget: { mintReppoSpent: 0, voteGasSpentEth: 0, mintGasSpentEth: 0, claimGasSpentEth: 0, caps: { mintReppoMax: 3000 } } })
    expect(buildMintEstimate({ datanetId: '9', snapshot: s, datanetPnl: [dn()] }).perCycleMax.known).toBe(false)
  })
})

describe('the remaining budget', () => {
  it("reports what is left under the operator's own mint cap", () => {
    const e = buildMintEstimate({ datanetId: '9', snapshot: snap(), datanetPnl: [dn()] })
    expect(e.budgetLeft).toMatchObject({ known: true, value: 2785 }) // 3000 − 215
  })

  it('never goes negative when the cap is already overspent', () => {
    const s = snap({ budget: { mintReppoSpent: 4000, voteGasSpentEth: 0, mintGasSpentEth: 0, claimGasSpentEth: 0, caps: { mintReppoMax: 3000 } } })
    expect(buildMintEstimate({ datanetId: '9', snapshot: s, datanetPnl: [dn()] }).budgetLeft).toMatchObject({ known: true, value: 0 })
  })

  it('is UNKNOWN on a node with no snapshot at all', () => {
    const e = buildMintEstimate({ datanetId: '9', snapshot: null, datanetPnl: [dn()] })
    expect(e.budgetLeft.known).toBe(false)
    expect(e.perCycleMax.known).toBe(false)
    expect(e.pays.emissionsPerEpochReppo).toBeNull() // null — not 0
  })
})

describe('what it pays', () => {
  const econ = (over = {}) => snap({
    datanetEconomics: [{
      datanetId: '9', emissionsPerEpochReppo: 1000, epoch: 116, epochVoteVolume: 1135826,
      yieldPerVote: 0.00088, uncontested: false, ...over,
    }],
  })

  it('reports the emission rate and the current yield', () => {
    const e = buildMintEstimate({ datanetId: '9', snapshot: econ(), datanetPnl: [dn()] })
    expect(e.pays.emissionsPerEpochReppo).toBe(1000)
    expect(e.pays.yieldPerVote).toBe(0.00088)
    expect(e.pays.yieldUnknown).toBeUndefined()
  })

  it('surfaces an uncontested epoch rather than a fake zero yield', () => {
    const e = buildMintEstimate({
      datanetId: '9',
      snapshot: econ({ epochVoteVolume: 0, yieldPerVote: null, uncontested: true }),
      datanetPnl: [dn()],
    })
    expect(e.pays.uncontested).toBe(true)
    expect(e.pays.yieldPerVote).toBeNull() // null, NOT 0
  })

  it('explains an unreadable yield instead of printing 0', () => {
    const e = buildMintEstimate({
      datanetId: '9',
      snapshot: econ({ epochVoteVolume: null, yieldPerVote: null, unavailableReason: 'rpc timeout' }),
      datanetPnl: [dn()],
    })
    expect(e.pays.yieldPerVote).toBeNull()
    expect(e.pays.yieldUnknown).toMatch(/could not read/i)
  })

  it('explains a datanet that pays a NON-REPPO token', () => {
    const e = buildMintEstimate({
      datanetId: '9',
      snapshot: econ({ emissionsPerEpochReppo: 0, nativeTokenSymbol: 'LBM', yieldPerVote: null }),
      datanetPnl: [dn()],
    })
    expect(e.pays.emissionsPerEpochReppo).toBe(0) // genuinely zero REPPO — it pays another token
    expect(e.pays.nativeTokenSymbol).toBe('LBM')
    expect(e.pays.yieldUnknown).toMatch(/emits no REPPO/i)
  })

  it('says the datanet is missing from the snapshot rather than inventing economics', () => {
    const e = buildMintEstimate({ datanetId: '404', snapshot: econ(), datanetPnl: [] })
    expect(e.pays.emissionsPerEpochReppo).toBeNull()
    expect(e.pays.yieldUnknown).toMatch(/not in the node's last snapshot/i)
  })
})
