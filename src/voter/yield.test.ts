// src/voter/yield.test.ts
import { describe, it, expect } from 'vitest'
import { computeYield, formatYieldLine } from './yield.js'

const econ = (rate: number, native = 'REPPO') => ({ emissionsPerEpochReppo: rate, nativeTokenSymbol: native })

describe('computeYield', () => {
  it('normal case: rate / epoch volume', () => {
    const y = computeYield('9', econ(500), { epoch: 42, totalRaw: 2_000_000n * 10n ** 18n })
    expect(y).toMatchObject({
      datanetId: '9', emissionsPerEpochReppo: 500, epoch: 42,
      epochVoteVolume: 2_000_000, yieldPerVote: 500 / 2_000_000, uncontested: false,
    })
    expect(y.nativeTokenSymbol).toBeUndefined() // REPPO is not a "native token"
  })

  it('zero volume: uncontested, yield null', () => {
    const y = computeYield('9', econ(500), { epoch: 42, totalRaw: 0n })
    expect(y.uncontested).toBe(true)
    expect(y.yieldPerVote).toBeNull()
    expect(y.epochVoteVolume).toBe(0)
  })

  it('RPC unavailable (null volume): everything null, not uncontested', () => {
    const y = computeYield('9', econ(500), null)
    expect(y).toMatchObject({ epoch: null, epochVoteVolume: null, yieldPerVote: null, uncontested: false })
  })

  it('zero rate, no native token: pays nothing, yield null even with volume', () => {
    const y = computeYield('3', econ(0), { epoch: 42, totalRaw: 10n ** 18n })
    expect(y.yieldPerVote).toBeNull()
    expect(y.nativeTokenSymbol).toBeUndefined()
  })

  it('native-token datanet: symbol carried, rate 0', () => {
    const y = computeYield('12', econ(0, 'LBM'), { epoch: 42, totalRaw: 0n })
    expect(y.nativeTokenSymbol).toBe('LBM')
  })
})

describe('formatYieldLine', () => {
  it('normal line carries rate, epoch, volume, yield', () => {
    const line = formatYieldLine(computeYield('9', econ(500), { epoch: 42, totalRaw: 2_000_000n * 10n ** 18n }))
    expect(line).toContain('500 REPPO/epoch')
    expect(line).toContain('epoch 42')
    expect(line).toContain('2,000,000')
    expect(line).toContain('2.50e-4/vote')
  })
  it('uncontested line', () => {
    expect(formatYieldLine(computeYield('9', econ(500), { epoch: 42, totalRaw: 0n }))).toContain('uncontested')
  })
  it('unavailable line', () => {
    expect(formatYieldLine(computeYield('9', econ(500), null))).toContain('yield unavailable')
  })
  it('pays-nothing line', () => {
    expect(formatYieldLine(computeYield('3', econ(0), { epoch: 42, totalRaw: 0n }))).toContain('pays nothing this epoch')
  })
  it('native-token line names the token', () => {
    expect(formatYieldLine(computeYield('12', econ(0, 'LBM'), null))).toContain('LBM')
  })
})
