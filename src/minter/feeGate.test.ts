import { describe, it, expect } from 'vitest'
import { mintFeeRatioExceeded, mintFeeLooksUnread, feeRatioPercent } from './feeGate.js'
import type { RubricEconomics } from '../rubric/types.js'

const econ = (over: Partial<RubricEconomics> = {}): RubricEconomics => ({
  accessFeeReppo: 0,
  emissionsPerEpochReppo: 2000,
  publishingFeeReppo: 300,
  upVoteVolume: 0,
  downVoteVolume: 0,
  nativeTokenSymbol: 'REPPO',
  ...over,
})

describe('mintFeeRatioExceeded', () => {
  it('blocks a fee above the max ratio', () => {
    // datanet 25: 300 / 2000 = 15%
    expect(mintFeeRatioExceeded(econ(), 0.03)).toBe(true)
  })

  it('allows a fee at or below the max ratio', () => {
    // datanet 9: 5 / 200 = 2.5% — the measured 3.5x-return datanet
    expect(mintFeeRatioExceeded(econ({ publishingFeeReppo: 5, emissionsPerEpochReppo: 200 }), 0.03)).toBe(false)
    // exactly at the boundary is allowed
    expect(mintFeeRatioExceeded(econ({ publishingFeeReppo: 60 }), 0.03)).toBe(false)
  })

  it('blocks datanet 2 at ~5%, the measured 0.77x loss', () => {
    expect(mintFeeRatioExceeded(econ({ publishingFeeReppo: 99 }), 0.03)).toBe(true)
  })

  it('never gates when maxRatio is undefined (feature off)', () => {
    expect(mintFeeRatioExceeded(econ(), undefined)).toBe(false)
  })

  it('never gates when the datanet emits no REPPO per epoch', () => {
    expect(mintFeeRatioExceeded(econ({ emissionsPerEpochReppo: 0 }), 0.03)).toBe(false)
  })

  it('never gates a non-REPPO datanet', () => {
    expect(mintFeeRatioExceeded(econ({ nativeTokenSymbol: 'WOOD' }), 0.03)).toBe(false)
  })

  it('gates a REPPO datanet regardless of symbol casing', () => {
    // case-insensitive: 'reppo' is still REPPO, so the gate still applies
    expect(mintFeeRatioExceeded(econ({ nativeTokenSymbol: 'reppo' }), 0.03)).toBe(true)
  })

  it('never gates when the fee is 0 or negative (unparseable reads land here)', () => {
    expect(mintFeeRatioExceeded(econ({ publishingFeeReppo: 0 }), 0.03)).toBe(false)
    expect(mintFeeRatioExceeded(econ({ publishingFeeReppo: -1 }), 0.03)).toBe(false)
  })
})

describe('mintFeeLooksUnread', () => {
  it('is true when a REPPO datanet reports no fee', () => {
    expect(mintFeeLooksUnread(econ({ publishingFeeReppo: 0 }))).toBe(true)
  })

  it('is false for a native-token datanet with no REPPO rate', () => {
    expect(mintFeeLooksUnread(econ({ publishingFeeReppo: 0, emissionsPerEpochReppo: 0, nativeTokenSymbol: 'WOOD' }))).toBe(false)
  })

  it('is false when a fee was actually read', () => {
    expect(mintFeeLooksUnread(econ())).toBe(false)
  })
})

describe('feeRatioPercent', () => {
  it('renders the ratio as a percentage', () => {
    expect(feeRatioPercent(econ())).toBe(15)
    expect(feeRatioPercent(econ({ publishingFeeReppo: 5, emissionsPerEpochReppo: 200 }))).toBe(2.5)
  })

  it('returns 0 rather than dividing by zero', () => {
    expect(feeRatioPercent(econ({ emissionsPerEpochReppo: 0 }))).toBe(0)
  })
})
