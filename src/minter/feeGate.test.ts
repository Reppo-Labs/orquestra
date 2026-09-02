import { describe, it, expect } from 'vitest'
import { mintFeeRatioExceeded, mintFeeLooksUnread, feeRatioPercent } from './feeGate.js'
import type { RubricEconomics } from '../rubric/types.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDatanetRubric } from '../rubric/parse.js'

const fixture = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/datanet-9.json'), 'utf-8'))

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

describe('fail-open against REAL parser output (not a hand-built literal)', () => {
  // Every other case in this file builds RubricEconomics BY HAND, which is exactly why
  // the parse-layer default was never exercised against the gate: rubric/parse.ts
  // defaults an unreadable/absent native symbol to the LITERAL 'REPPO' (`... || 'REPPO'`),
  // so a hand-written `nativeTokenSymbol: 'WOOD'` can never reproduce the case where a
  // genuinely non-REPPO datanet arrives symbol-less. This test therefore PARSES a real
  // CLI payload rather than constructing economics. The payload shape is the one
  // rubric/parse.test.ts already pins as a genuine non-REPPO datanet with an empty
  // catalog symbol ("classifies a non-REPPO datanet by primary ADDRESS ...").
  const nonReppoSymbolless = parseDatanetRubric({
    ...fixture,
    // catalog symbol unreadable (the CLI's symbol() catch-fallback) → parse.ts defaults it to 'REPPO'
    nativeTokenSymbol: '',
    nativeToken: { address: '0xExy0000000000000000000000000000000000001', decimals: 6 },
    primaryToken: { address: '0xExy0000000000000000000000000000000000001', symbol: '', decimals: 6 },
    accessFeePrimaryToken: { raw: '50000000', formatted: '50' },
    // Native-denominated economics: a fee/emissions pair that WOULD trip the gate if
    // these were read as two REPPO quantities (300 / 500 = 60% >> 3%).
    publishingFeeREPPO: 300,
    emissionsPerEpochREPPO: 500,
  })

  it('parse.ts really does hand the gate a REPPO symbol here (the hole, pinned)', () => {
    expect(nonReppoSymbolless.economics.nativeTokenSymbol).toBe('REPPO')
    expect(nonReppoSymbolless.economics.accessFeeToken).toBeDefined()
  })

  it('never gates a symbol-less NON-REPPO datanet (address-derived signal wins)', () => {
    expect(mintFeeRatioExceeded(nonReppoSymbolless.economics, 0.03)).toBe(false)
  })

  it('does not claim the fee is unread on a symbol-less non-REPPO datanet', () => {
    expect(mintFeeLooksUnread({ ...nonReppoSymbolless.economics, publishingFeeReppo: 0 })).toBe(false)
  })
})
