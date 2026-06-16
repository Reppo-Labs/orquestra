// src/rubric/parse.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDatanetRubric } from './parse.js'
import { RubricUnavailableError } from './types.js'

const fixture = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/datanet-9.json'), 'utf-8'))
const nestedFixture = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/datanet-9-cli-0.7.json'), 'utf-8'))

describe('parseDatanetRubric', () => {
  it('maps metadata fields into a DatanetRubric', () => {
    const r = parseDatanetRubric(fixture)
    expect(r.datanetId).toBe('9')
    expect(r.name).toBe('TradingGym AI')
    expect(r.goal).toMatch(/training data marketplace/)
    expect(r.publisherSpec).toMatch(/Hyperliquid perp trading data/)
    expect(r.voterRubric).toMatch(/Score Pods 1-10/)
    expect(r.economics.accessFeeReppo).toBe(50)
    expect(r.economics.upVoteVolume).toBe(9668144)
  })

  it('accepts tokenId as an alias for datanetId', () => {
    const { datanetId, ...rest } = fixture
    const r = parseDatanetRubric({ ...rest, tokenId: '9' })
    expect(r.datanetId).toBe('9')
  })

  it('sets canVote + canMint when both rubrics are present', () => {
    const r = parseDatanetRubric(fixture)
    expect(r.canVote).toBe(true)
    expect(r.canMint).toBe(true)
  })

  it('missing voter rubric → mint-only (canMint true, canVote false), not rejected', () => {
    const { onboardingVoters, ...rest } = fixture
    const r = parseDatanetRubric(rest)
    expect(r.voterRubric).toBe('')
    expect(r.canVote).toBe(false)
    expect(r.canMint).toBe(true)
    expect(r.goal).toMatch(/training data marketplace/)
  })

  it('missing publisher spec → vote-only (canVote true, canMint false), not rejected', () => {
    const { onboardingPublishers, ...rest } = fixture
    const r = parseDatanetRubric(rest)
    expect(r.publisherSpec).toBe('')
    expect(r.canVote).toBe(true)
    expect(r.canMint).toBe(false)
  })

  it('throws RubricUnavailableError when goal, voter rubric, and publisher spec are all missing', () => {
    const { subnetDescription, onboardingPublishers, onboardingVoters, ...rest } = fixture
    expect(() => parseDatanetRubric(rest)).toThrow(RubricUnavailableError)
  })
})

describe('parseDatanetRubric — CLI 0.7.0 nested shape', () => {
  it('reads goal from metadata.description', () => {
    const r = parseDatanetRubric(nestedFixture)
    expect(r.goal).toMatch(/RL gym|training data/)
  })

  it('reads publisherSpec from metadata.onboardingPublishers', () => {
    const r = parseDatanetRubric(nestedFixture)
    expect(r.publisherSpec).toMatch(/Hyperliquid/)
  })

  it('reads subnetUuid from metadata (required by reppo 0.8.0 mint-pod --subnet-uuid)', () => {
    expect(parseDatanetRubric(nestedFixture).subnetUuid).toBe('00000000-0000-0000-0000-000000000009')
  })

  it('subnetUuid is empty string when absent (flat pre-0.7 shape)', () => {
    expect(parseDatanetRubric(fixture).subnetUuid).toBe('')
  })

  it('reads voterRubric from metadata.onboardingVoters', () => {
    const r = parseDatanetRubric(nestedFixture)
    expect(r.voterRubric).toMatch(/Score Pods/)
  })

  it('reads name from metadata.name', () => {
    const r = parseDatanetRubric(nestedFixture)
    expect(r.name).toBe('TradingGym AI')
  })

  it('sets canVote and canMint true when both specs are present', () => {
    const r = parseDatanetRubric(nestedFixture)
    expect(r.canVote).toBe(true)
    expect(r.canMint).toBe(true)
  })

  it('reads upVoteVolume from metadata', () => {
    const r = parseDatanetRubric(nestedFixture)
    expect(r.economics.upVoteVolume).toBe(9668144)
  })

  it('reads nativeTokenSymbol from metadata.nativeToken.symbol', () => {
    const r = parseDatanetRubric(nestedFixture)
    expect(r.economics.nativeTokenSymbol).toBe('REPPO')
  })

  it('reads accessFeeReppo from top-level accessFeeREPPO object', () => {
    const r = parseDatanetRubric(nestedFixture)
    expect(Number.isFinite(r.economics.accessFeeReppo)).toBe(true)
    expect(r.economics.accessFeeReppo).toBeGreaterThan(0)
  })

  it('preserves datanetId from top level', () => {
    const r = parseDatanetRubric(nestedFixture)
    expect(r.datanetId).toBe('9')
  })
})

describe('parseDatanetRubric — non-REPPO access fee (accessFeeToken)', () => {
  it('leaves accessFeeToken undefined for a REPPO-fee datanet (today, unchanged)', () => {
    const r = parseDatanetRubric(fixture)
    expect(r.economics.accessFeeToken).toBeUndefined()
    expect(r.economics.accessFeeReppo).toBe(50) // existing REPPO field unchanged
  })

  it('leaves accessFeeToken undefined even when the CLI emits accessFeePrimaryToken but the primary token IS REPPO', () => {
    const r = parseDatanetRubric({
      ...fixture,
      // primary token that is just REPPO again → must NOT route to --token primary
      primaryToken: { address: '0xFf8104251E7761163faC3211eF5583FB3F8583d6', decimals: 18 },
      accessFeePrimaryToken: { raw: '50000000000000000000', formatted: '50' },
      nativeToken: { symbol: 'REPPO', address: '0xFf8104251E7761163faC3211eF5583FB3F8583d6', decimals: 18 },
    })
    expect(r.economics.accessFeeToken).toBeUndefined()
  })

  it('populates accessFeeToken for an EXY datanet (non-REPPO primary token, positive fee)', () => {
    const exy = {
      ...fixture,
      datanetId: '42',
      subnetName: 'Exylos',
      nativeTokenSymbol: 'EXY',
      nativeToken: { symbol: 'EXY', address: '0xExy0000000000000000000000000000000000001', decimals: 6 },
      // primaryToken now carries the on-chain symbol() — accessFeeToken.symbol must come from it.
      primaryToken: { address: '0xExy0000000000000000000000000000000000001', symbol: 'EXY', decimals: 6 },
      accessFeePrimaryToken: { raw: '50000000', formatted: '50' },
      // the REPPO fee field is irrelevant for a non-REPPO datanet but kept for shape parity
      accessFeeREPPO: { raw: '0', formatted: '0' },
    }
    const r = parseDatanetRubric(exy)
    expect(r.economics.accessFeeToken).toEqual({
      address: '0xExy0000000000000000000000000000000000001',
      symbol: 'EXY',
      decimals: 6,
      amount: 50,
      amountRaw: '50000000', // raw integer carried verbatim from accessFeePrimaryToken.raw
    })
  })

  it('takes the symbol from the primary token, not the catalog (primary symbol wins)', () => {
    const r = parseDatanetRubric({
      ...fixture,
      // catalog says GENERIC, but the primary token's on-chain symbol() is the authority.
      nativeTokenSymbol: 'GENERIC',
      nativeToken: { symbol: 'GENERIC', address: '0xExy0000000000000000000000000000000000001', decimals: 6 },
      primaryToken: { address: '0xExy0000000000000000000000000000000000001', symbol: 'EXY', decimals: 6 },
      accessFeePrimaryToken: { raw: '50000000', formatted: '50' },
    })
    expect(r.economics.accessFeeToken?.symbol).toBe('EXY')
  })

  it('classifies a non-REPPO datanet by primary ADDRESS even when the catalog symbol is empty', () => {
    const r = parseDatanetRubric({
      ...fixture,
      // no catalog symbol at all (empty/missing) — classification must still fire off the address.
      nativeTokenSymbol: '',
      nativeToken: { address: '0xExy0000000000000000000000000000000000001', decimals: 6 },
      // primary symbol also empty (symbol() catch-fallback) → symbol falls back to nativeSymbol
      primaryToken: { address: '0xExy0000000000000000000000000000000000001', symbol: '', decimals: 6 },
      accessFeePrimaryToken: { raw: '50000000', formatted: '50' },
    })
    expect(r.economics.accessFeeToken).toBeDefined()
    expect(r.economics.accessFeeToken?.address).toBe('0xExy0000000000000000000000000000000000001')
    expect(r.economics.accessFeeToken?.amountRaw).toBe('50000000')
  })

  it('leaves accessFeeToken undefined when primary decimals are missing/NaN (read failure, never default to 0)', () => {
    const r = parseDatanetRubric({
      ...fixture,
      nativeToken: { symbol: 'EXY', address: '0xExy0000000000000000000000000000000000001', decimals: 6 },
      primaryToken: { address: '0xExy0000000000000000000000000000000000001', symbol: 'EXY' }, // no decimals
      accessFeePrimaryToken: { raw: '50000000', formatted: '50' },
    })
    expect(r.economics.accessFeeToken).toBeUndefined()
  })

  it('leaves accessFeeToken undefined when the primary fee is unavailable or zero', () => {
    const unavailable = parseDatanetRubric({
      ...fixture,
      nativeToken: { symbol: 'EXY', address: '0xExy0000000000000000000000000000000000001', decimals: 6 },
      primaryToken: { address: '0xExy0000000000000000000000000000000000001', decimals: 6 },
      accessFeePrimaryToken: { unavailable: 'no primary fee set' },
    })
    expect(unavailable.economics.accessFeeToken).toBeUndefined()

    const zero = parseDatanetRubric({
      ...fixture,
      nativeToken: { symbol: 'EXY', address: '0xExy0000000000000000000000000000000000001', decimals: 6 },
      primaryToken: { address: '0xExy0000000000000000000000000000000000001', decimals: 6 },
      accessFeePrimaryToken: { raw: '0', formatted: '0' },
    })
    expect(zero.economics.accessFeeToken).toBeUndefined()
  })

  it('leaves accessFeeToken undefined when primaryToken is absent (older CLI)', () => {
    const r = parseDatanetRubric({
      ...fixture,
      nativeToken: { symbol: 'EXY', address: '0xExy0000000000000000000000000000000000001', decimals: 6 },
      accessFeePrimaryToken: { raw: '50000000', formatted: '50' },
      // no primaryToken → cannot derive address/decimals → stay on REPPO path
    })
    expect(r.economics.accessFeeToken).toBeUndefined()
  })
})
