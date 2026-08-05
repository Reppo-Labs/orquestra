import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  consentPath,
  isTelemetryEnabled,
  markNoticeShown,
  needsNotice,
  readConsent,
  setTelemetryEnabled,
  shouldTransmit,
  OPT_OUT_ENV,
} from './consent.js'
import { showNoticeIfNeeded, noticeText } from './notice.js'

let dirs: string[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orq-tel-'))
  dirs.push(d)
  return d
}

beforeEach(() => { dirs = [] })
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('default state', () => {
  it('defaults to enabled with the notice not yet shown', () => {
    const s = readConsent(tmp())
    expect(s.enabled).toBe(true)
    expect(s.noticeShown).toBe(false)
  })

  it('a corrupt file degrades toward disclosure, not away from it', () => {
    // The dangerous failure would be enabled:true + noticeShown:true — a node that
    // resumes transmitting without ever re-disclosing. Corruption must not produce it.
    const dir = tmp()
    writeFileSync(consentPath(dir), '{ truncated')
    const s = readConsent(dir)
    expect(s.enabled).toBe(true)
    expect(s.noticeShown).toBe(false)
    expect(shouldTransmit(dir, {})).toBe(false)
  })

  it('a partially-shaped file is treated as corrupt', () => {
    const dir = tmp()
    writeFileSync(consentPath(dir), JSON.stringify({ enabled: true })) // no noticeShown
    expect(readConsent(dir).noticeShown).toBe(false)
  })
})

describe('notice gate', () => {
  it('blocks transmission until the notice has been shown', () => {
    const dir = tmp()
    expect(needsNotice(dir)).toBe(true)
    expect(shouldTransmit(dir, {})).toBe(false)
    markNoticeShown(dir)
    expect(shouldTransmit(dir, {})).toBe(true)
  })

  it('shows the notice once, records it, and stays silent on that run', () => {
    const dir = tmp()
    const out = vi.fn()
    expect(showNoticeIfNeeded(dir, out)).toBe(true)
    expect(out).toHaveBeenCalledOnce()
    // The whole point: the run that displays the notice must not also transmit.
    // shouldTransmit is only consulted after this, and by then noticeShown is true —
    // so the caller is responsible for ordering. Assert the record, not the ordering.
    expect(needsNotice(dir)).toBe(false)
    expect(showNoticeIfNeeded(dir, out)).toBe(false)
    expect(out).toHaveBeenCalledOnce()
  })

  it('treats an upgraded pre-telemetry node as never notified', () => {
    // No consent file at all is exactly the state of a node upgraded from a version
    // that predates telemetry. It must get the notice, not a silent first send.
    const dir = tmp()
    expect(existsSync(consentPath(dir))).toBe(false)
    expect(shouldTransmit(dir, {})).toBe(false)
    const out = vi.fn()
    expect(showNoticeIfNeeded(dir, out)).toBe(true)
  })

  it('notice text names what is never sent, and the opt-out routes', () => {
    const t = noticeText()
    expect(t).toContain('NEVER sent')
    expect(t).toContain('wallet address')
    expect(t).toContain('telemetry --show')
    expect(t).toContain('telemetry --off')
    expect(t).toContain(OPT_OUT_ENV)
  })
})

describe('operator controls', () => {
  it('disabling persists and survives re-reads', () => {
    const dir = tmp()
    markNoticeShown(dir)
    setTelemetryEnabled(dir, false)
    expect(isTelemetryEnabled(dir, {})).toBe(false)
    expect(shouldTransmit(dir, {})).toBe(false)
  })

  it('disabling preserves the notice record', () => {
    const dir = tmp()
    markNoticeShown(dir)
    setTelemetryEnabled(dir, false)
    expect(readConsent(dir).noticeShown).toBe(true)
  })

  it('re-enabling works and does not re-trigger the notice', () => {
    const dir = tmp()
    markNoticeShown(dir)
    setTelemetryEnabled(dir, false)
    setTelemetryEnabled(dir, true)
    expect(shouldTransmit(dir, {})).toBe(true)
  })

  it('env var overrides stored enabled state', () => {
    const dir = tmp()
    markNoticeShown(dir)
    expect(shouldTransmit(dir, {})).toBe(true)
    expect(shouldTransmit(dir, { [OPT_OUT_ENV]: '1' })).toBe(false)
  })

  it('env var does NOT mutate the stored decision', () => {
    // An operator killing telemetry for one CI run must not lose their real setting.
    const dir = tmp()
    markNoticeShown(dir)
    setTelemetryEnabled(dir, true)
    const before = readFileSync(consentPath(dir), 'utf-8')
    expect(isTelemetryEnabled(dir, { [OPT_OUT_ENV]: '1' })).toBe(false)
    expect(readFileSync(consentPath(dir), 'utf-8')).toBe(before)
  })

  it('an empty env var is not an opt-out', () => {
    const dir = tmp()
    markNoticeShown(dir)
    expect(shouldTransmit(dir, { [OPT_OUT_ENV]: '' })).toBe(true)
  })
})
