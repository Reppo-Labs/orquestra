// src/rubric/load.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDatanetRubric, clearRubricCache } from './load.js'
import { RubricUnavailableError } from './types.js'

const fixture = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/datanet-9.json'), 'utf-8'))

beforeEach(() => clearRubricCache())

describe('getDatanetRubric', () => {
  it('fetches + parses via the injected fetcher', async () => {
    const r = await getDatanetRubric('9', { fetcher: async () => fixture })
    expect(r.name).toBe('TradingGym AI')
    expect(r.voterRubric).toMatch(/North star/)
  })

  it('caches per id: the fetcher runs once across repeated calls', async () => {
    let calls = 0
    const fetcher = async () => { calls++; return fixture }
    await getDatanetRubric('9', { fetcher })
    await getDatanetRubric('9', { fetcher })
    expect(calls).toBe(1)
  })

  it('refetches when refresh: true', async () => {
    let calls = 0
    const fetcher = async () => { calls++; return fixture }
    await getDatanetRubric('9', { fetcher })
    await getDatanetRubric('9', { fetcher, refresh: true })
    expect(calls).toBe(2)
  })

  it('propagates RubricUnavailableError from the parser', async () => {
    const { onboardingVoters, subnetDescription, ...rest } = fixture
    await expect(getDatanetRubric('9', { fetcher: async () => rest })).rejects.toThrow(RubricUnavailableError)
  })
})
