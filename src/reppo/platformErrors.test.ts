import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordPlatformError, readPlatformErrors, countPlatformErrorsSince } from './platformErrors.js'
import { _resetDbs } from '../dashboard/db.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-plat-')) })
afterEach(() => { _resetDbs(); rmSync(dir, { recursive: true, force: true }) })

const entry = (over: Partial<Parameters<typeof recordPlatformError>[1]> = {}) => ({
  ts: '2026-08-13T12:00:00.000Z', kind: 'mint' as const, message: 'boom', ...over,
})

describe('platformErrors', () => {
  it('round-trips every field, newest-first', () => {
    recordPlatformError(dir, entry({ ts: '2026-08-13T12:00:00.000Z', podId: '10' }))
    recordPlatformError(dir, entry({
      ts: '2026-08-13T13:00:00.000Z', kind: 'vote', datanetId: '3', podId: '3750',
      txHash: '0xabc', stage: 'register', httpStatus: 404, code: 'POD_NOT_FOUND',
      message: '{"error":"Pod not found"}',
    }))
    const out = readPlatformErrors(dir, { limit: 10 })
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      ts: '2026-08-13T13:00:00.000Z', kind: 'vote', datanetId: '3', podId: '3750',
      txHash: '0xabc', stage: 'register', httpStatus: 404, code: 'POD_NOT_FOUND',
      message: '{"error":"Pod not found"}',
    })
    expect(out[1].podId).toBe('10')
  })

  it('redacts secrets in the stored body', () => {
    // Platform error text echoes the request, and the node's RPC URL carries an API key.
    recordPlatformError(dir, entry({ message: 'failed calling https://base-mainnet.g.alchemy.com/v2/sk_live_abcd1234efgh' }))
    expect(readPlatformErrors(dir, { limit: 1 })[0].message).not.toContain('sk_live_abcd1234efgh')
  })

  it('counts only failures at or after the cutoff', () => {
    recordPlatformError(dir, entry({ ts: '2026-08-12T23:59:59.000Z' }))
    recordPlatformError(dir, entry({ ts: '2026-08-13T00:00:00.000Z' }))
    recordPlatformError(dir, entry({ ts: '2026-08-13T09:00:00.000Z' }))
    expect(countPlatformErrorsSince(dir, '2026-08-13T00:00:00.000Z')).toBe(2)
  })

  it('never throws when the store is unusable — the caller is on a success path', () => {
    // A cycle records this AFTER a landed mint/vote. Escalating a storage problem into a
    // thrown error would abort a cycle over bookkeeping for a tx that already succeeded.
    const unwritable = join(dir, 'no', 'such', 'dir')
    expect(() => recordPlatformError(unwritable, entry())).not.toThrow()
    expect(readPlatformErrors(unwritable, { limit: 5 })).toEqual([])
    expect(countPlatformErrorsSince(unwritable, '2026-01-01T00:00:00.000Z')).toBe(0)
  })
})
