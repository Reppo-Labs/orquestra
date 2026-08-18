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
