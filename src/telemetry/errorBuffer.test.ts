import { describe, it, expect, beforeEach } from 'vitest'
import { recordErrorSignature, drainErrorSignatures, peekErrorSignatures, resetErrorBuffer } from './errorBuffer.js'
import { MAX_SIGNATURES } from './signature.js'
import { validateReport } from '../collector/validate.js'
import { buildPayload, serializePayload } from './payload.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetDbs } from '../dashboard/db.js'

beforeEach(() => resetErrorBuffer())

/** An Error with a stack that normalizes to stable frames. */
const err = (cls: string, fn: string): Error => {
  const e = new Error('a message that must never be transmitted')
  e.name = cls
  e.stack = `${cls}: a message that must never be transmitted\n    at ${fn} (/Users/someone/code/orquestra/src/runtime/cycle.ts:42:7)`
  return e
}

describe('errorBuffer', () => {
  it('collects a signature and drains it', () => {
    recordErrorSignature(err('TypeError', 'runCycle'))
    const out = drainErrorSignatures()
    expect(out).toHaveLength(1)
    expect(out[0].errorClass).toBe('TypeError')
    expect(out[0].frames[0]).toContain('src/runtime/cycle.ts')
    expect(drainErrorSignatures()).toEqual([]) // drain empties
  })

  it('never transmits the error message', () => {
    recordErrorSignature(err('TypeError', 'runCycle'))
    expect(JSON.stringify(drainErrorSignatures())).not.toContain('must never be transmitted')
  })

  it('dedupes a fault that repeats — the loop case', () => {
    // The install that motivated this was recording ~10 errors per cycle. Without dedup a
    // single repeating fault would exhaust the report's signature budget by itself.
    for (let i = 0; i < 50; i++) recordErrorSignature(err('TypeError', 'runCycle'))
    expect(drainErrorSignatures()).toHaveLength(1)
  })

  it('caps at MAX_SIGNATURES and keeps the FIRST seen, not the last', () => {
    // First-seen wins on purpose: the earliest fault of a cycle is usually the cause and
    // the later ones its consequences, so evicting the oldest would report the symptom
    // and drop the trigger.
    for (let i = 0; i < MAX_SIGNATURES + 10; i++) recordErrorSignature(err('TypeError', `fn${i}`))
    const out = drainErrorSignatures()
    expect(out).toHaveLength(MAX_SIGNATURES)
    expect(out[0].frames[0]).toContain('fn0 ')
    expect(JSON.stringify(out)).not.toContain(`fn${MAX_SIGNATURES + 5} `)
  })

  it('keeps CLI faults apart when their stacks are identical', () => {
    // Regression. Every reppo CLI failure surfaces through the same `run` frame, so a
    // dedup key of (class, frames) folded three genuinely different faults into one and
    // kept only the first — undoing the whole point of the code field at the last step.
    // The other tests in this file use distinct stacks, where the bug cannot show.
    const cli = (message: string): Error => {
      const e = new Error(message)
      e.stack = `Error: ${message}\n    at run (/app/dist/reppo/cli.js:140:11)`
      return e
    }
    recordErrorSignature(cli('error: VOTER_LACKS_SUBNET_ACCESS: no access'))
    recordErrorSignature(cli('error: INSUFFICIENT_REPPO_BALANCE: wallet empty'))
    recordErrorSignature(cli('error: UNKNOWN_REVERT_0x5dd58b8b'))
    recordErrorSignature(cli('error: VOTER_LACKS_SUBNET_ACCESS: no access again')) // same fault
    const codes = drainErrorSignatures().map((s) => s.code)
    expect(codes).toEqual(['VOTER_LACKS_SUBNET_ACCESS', 'INSUFFICIENT_REPPO_BALANCE', 'UNKNOWN_REVERT_0x5dd58b8b'])
  })

  it('peek does not consume — `telemetry --show` must be read-only', () => {
    recordErrorSignature(err('TypeError', 'runCycle'))
    expect(peekErrorSignatures()).toHaveLength(1)
    expect(peekErrorSignatures()).toHaveLength(1)
    expect(drainErrorSignatures()).toHaveLength(1)
  })

  it('never throws, whatever was thrown', () => {
    // Every call site is already on a failure path; an exception here would turn a
    // handled, isolated error into an unhandled one.
    for (const v of [undefined, null, 'a string', 42, { nope: true }, Object.create(null)]) {
      expect(() => recordErrorSignature(v)).not.toThrow()
    }
  })
})

describe('errorBuffer ↔ collector limit', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-tel-')) })

  it('a saturated buffer still produces a report the collector ACCEPTS', () => {
    // The load-bearing test. The collector rejects an over-long signature array with
    // `bad-signature`, and that drops the ENTIRE report — counts included. So a node
    // erroring hard would have gone completely dark in telemetry at exactly the moment it
    // became worth watching. This pins the node's cap to the collector's rule.
    for (let i = 0; i < MAX_SIGNATURES * 5; i++) recordErrorSignature(err('TypeError', `fn${i}`))
    const payload = buildPayload(dir, { errorSignatures: drainErrorSignatures() })
    expect(payload.errorSignatures).toHaveLength(MAX_SIGNATURES)
    const result = validateReport(serializePayload(payload))
    expect(result.ok).toBe(true)
    _resetDbs()
    rmSync(dir, { recursive: true, force: true })
  })
})
