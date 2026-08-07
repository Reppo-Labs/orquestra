import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { telemetryCmd } from './cmd.js'
import { buildPayload, serializePayload } from './payload.js'
import { isTelemetryEnabled, markNoticeShown, OPT_OUT_ENV, readConsent } from './consent.js'

let dirs: string[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orq-tel-'))
  dirs.push(d)
  return d
}

function io() {
  const out: string[] = []
  const err: string[] = []
  return { out: (s: string) => out.push(s), err: (s: string) => err.push(s), _out: out, _err: err }
}

beforeEach(() => { dirs = [] })
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('--show (tasks 3.2, 3.3)', () => {
  it('prints the payload byte-identically to what would be transmitted', () => {
    // The privacy claim rests on this: an operator inspecting the payload must be seeing
    // the real thing, not a second rendering that can drift from the sender.
    const dir = tmp()
    const now = () => new Date('2026-08-04T12:00:00.000Z')
    const sent = serializePayload(buildPayload(dir, { now }))

    const o = io()
    expect(telemetryCmd(dir, ['--show'], o, {})).toBe(0)
    const shown = o._out.join('\n')

    // Only `ts` differs (built a moment later); normalize it and compare the rest exactly.
    const norm = (s: string) => s.replace(/"ts": "[^"]+"/, '"ts": "<ts>"')
    expect(norm(shown)).toBe(norm(sent))
  })

  it('emits valid JSON on stdout', () => {
    const o = io()
    telemetryCmd(tmp(), ['--show'], o, {})
    expect(() => JSON.parse(o._out.join('\n'))).not.toThrow()
  })

  it('does not mark the notice as shown, and does not enable anything', () => {
    // Inspecting must not be construed as being informed, nor as consenting.
    const dir = tmp()
    telemetryCmd(dir, ['--show'], io(), {})
    expect(readConsent(dir).noticeShown).toBe(false)
  })
})

describe('--off / --on (task 3.1)', () => {
  it('--off persists a disable', () => {
    const dir = tmp()
    markNoticeShown(dir)
    expect(telemetryCmd(dir, ['--off'], io(), {})).toBe(0)
    expect(isTelemetryEnabled(dir, {})).toBe(false)
  })

  it('--on re-enables and re-prints what is collected', () => {
    const dir = tmp()
    const o = io()
    telemetryCmd(dir, ['--off'], o, {})
    telemetryCmd(dir, ['--on'], o, {})
    expect(isTelemetryEnabled(dir, {})).toBe(true)
    expect(o._err.join('\n')).toContain('NEVER sent')
  })
})

describe('status (no flag)', () => {
  it('reports enabled state and that nothing has been sent yet', () => {
    const o = io()
    telemetryCmd(tmp(), [], o, {})
    const s = o._err.join('\n')
    expect(s).toContain('telemetry: enabled')
    expect(s).toContain('nothing has been transmitted')
  })

  it('distinguishes an env-var disable from a stored one', () => {
    const dir = tmp()
    markNoticeShown(dir)
    const o = io()
    telemetryCmd(dir, [], o, { [OPT_OUT_ENV]: '1' })
    const s = o._err.join('\n')
    expect(s).toContain('telemetry: disabled')
    expect(s).toContain('stored setting is unchanged')
  })

  it('rejects an unknown flag with exit 2', () => {
    expect(telemetryCmd(tmp(), ['--wat'], io(), {})).toBe(2)
  })
})
