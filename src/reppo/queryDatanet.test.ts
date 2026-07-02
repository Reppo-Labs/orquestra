import { describe, it, expect, vi } from 'vitest'
import { queryDatanetJson } from './queryDatanet.js'
import * as exec from './exec.js'

const run = (json: string) => vi.spyOn(exec, 'runReppoStdout').mockResolvedValue(json)

describe('queryDatanetJson degraded-response guard', () => {
  it('returns the parsed object for a full metadata response', async () => {
    run(JSON.stringify({ datanetId: '23', metadata: { description: 'x', onboardingVoters: 'y' } }))
    const r = (await queryDatanetJson('23')) as Record<string, unknown>
    expect(r['datanetId']).toBe('23')
  })

  it('throws transient INTERNAL_ERROR when the body is an {error} object', async () => {
    run(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'RPC Request failed.' } }))
    const err = (await queryDatanetJson('23').catch((e) => e)) as Error
    expect(err.message).toMatch(/INTERNAL_ERROR/)
    expect(exec.isTransientReppoError(err.message)).toBe(true)
  })

  it('throws transient INTERNAL_ERROR when id resolved but metadata is absent', async () => {
    run(JSON.stringify({ datanetId: '23', network: 'mainnet', valid: true }))
    const err = (await queryDatanetJson('23').catch((e) => e)) as Error
    expect(err.message).toMatch(/INTERNAL_ERROR/)
    expect(exec.isTransientReppoError(err.message)).toBe(true)
  })

  it('still accepts a flat (pre-0.7.0) shape with top-level onboardingVoters', async () => {
    run(JSON.stringify({ datanetId: '9', onboardingVoters: 'rubric text' }))
    const r = (await queryDatanetJson('9')) as Record<string, unknown>
    expect(r['onboardingVoters']).toBe('rubric text')
  })
})
