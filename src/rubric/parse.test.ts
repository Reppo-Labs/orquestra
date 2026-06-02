// src/rubric/parse.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDatanetRubric } from './parse.js'
import { RubricUnavailableError } from './types.js'

const fixture = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/datanet-9.json'), 'utf-8'))

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

  it('keeps a missing voter rubric as empty (still mintable, gated downstream)', () => {
    const { onboardingVoters, ...rest } = fixture
    const r = parseDatanetRubric(rest)
    expect(r.voterRubric).toBe('')
    expect(r.goal).toMatch(/training data marketplace/)
    expect(r.publisherSpec).toMatch(/Hyperliquid perp trading data/)
  })

  it('keeps a missing publisher spec as empty (still voteable, gated downstream)', () => {
    const { onboardingPublishers, ...rest } = fixture
    const r = parseDatanetRubric(rest)
    expect(r.publisherSpec).toBe('')
    expect(r.voterRubric).toMatch(/Score Pods 1-10/)
  })

  it('throws RubricUnavailableError when goal, voter rubric, and publisher spec are all missing', () => {
    const { subnetDescription, onboardingPublishers, onboardingVoters, ...rest } = fixture
    expect(() => parseDatanetRubric(rest)).toThrow(RubricUnavailableError)
  })
})
