import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discloseTelemetry } from './onboarding.js'
import { readConsent, shouldTransmit } from './consent.js'

let dirs: string[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orq-tel-'))
  dirs.push(d)
  return d
}

function prompter(answer: string) {
  const info: string[] = []
  const asked: string[] = []
  return {
    ask: async (q: string) => { asked.push(q); return answer },
    info: (m: string) => { info.push(m) },
    _info: info,
    _asked: asked,
  }
}

beforeEach(() => { dirs = [] })
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('discloseTelemetry', () => {
  it('shows what is collected and what is never collected before asking', () => {
    const p = prompter('Y')
    return discloseTelemetry(tmp(), p).then(() => {
      const shown = p._info.join('\n')
      expect(shown).toContain('NEVER sent')
      expect(shown).toContain('wallet address')
      expect(p._asked).toHaveLength(1)
    })
  })

  it('leaves telemetry enabled when the operator accepts the default', async () => {
    const dir = tmp()
    expect(await discloseTelemetry(dir, prompter(''))).toBe(true)
    expect(shouldTransmit(dir, {})).toBe(true)
  })

  it('disables immediately when the operator declines, suppressing that same run', async () => {
    const dir = tmp()
    expect(await discloseTelemetry(dir, prompter('n'))).toBe(false)
    // The spec requires the decision to bite for the current run, not the next one.
    expect(shouldTransmit(dir, {})).toBe(false)
  })

  it.each(['n', 'N', 'no', 'No', ' off ', 'disable', 'false'])('treats %o as a decline', async (a) => {
    const dir = tmp()
    expect(await discloseTelemetry(dir, prompter(a))).toBe(false)
  })

  it.each(['y', 'yes', '', 'sure', 'ok'])('treats %o as keeping the default', async (a) => {
    const dir = tmp()
    expect(await discloseTelemetry(dir, prompter(a))).toBe(true)
  })

  it('records the notice as shown either way', async () => {
    const yes = tmp()
    await discloseTelemetry(yes, prompter('y'))
    expect(readConsent(yes).noticeShown).toBe(true)

    const no = tmp()
    await discloseTelemetry(no, prompter('n'))
    expect(readConsent(no).noticeShown).toBe(true)
  })

  it('re-running preserves a prior decline when the operator accepts the prompt default', async () => {
    // Re-running onboarding must not silently re-enable telemetry someone turned off.
    const dir = tmp()
    await discloseTelemetry(dir, prompter('n'))
    expect(await discloseTelemetry(dir, prompter('n'))).toBe(false)
    expect(shouldTransmit(dir, {})).toBe(false)
  })
})
