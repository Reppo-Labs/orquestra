// src/dashboard/onboardingSession.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadOnboardingSession,
  saveOnboardingSession,
  clearOnboardingSession,
  sessionView,
} from './onboardingSession.js'
import type { OnboardingSession } from './routes.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ob-session-')) })

const session = (): OnboardingSession => ({
  messages: [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'Begin onboarding. Greet me briefly and ask what I want my node to do.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi! What should we call your node?' }] },
    { role: 'user', content: 'Major Oak' },
    { role: 'assistant', content: 'Great name.' },
  ],
  draft: { nodeName: 'Major Oak' },
  finalized: null,
})

describe('onboarding session persistence', () => {
  it('round-trips messages + draft through disk', () => {
    saveOnboardingSession(dir, session())
    const loaded = loadOnboardingSession(dir)
    expect(loaded.messages).toHaveLength(5)
    expect(loaded.draft).toEqual({ nodeName: 'Major Oak' })
    expect(loaded.finalized).toBeNull()
  })

  it('absent file → empty session (fresh node)', () => {
    const s = loadOnboardingSession(dir)
    expect(s.messages).toEqual([])
    expect(s.draft).toBeNull()
  })

  it('corrupt file → empty session, never a throw (unlike the budget ledger, losing a chat is safe)', () => {
    writeFileSync(join(dir, 'onboarding-session.json'), '{truncated')
    expect(loadOnboardingSession(dir).messages).toEqual([])
  })

  it('clear removes the persisted session', () => {
    saveOnboardingSession(dir, session())
    clearOnboardingSession(dir)
    expect(loadOnboardingSession(dir).messages).toEqual([])
  })
})

describe('sessionView', () => {
  it('projects operator + assistant text, hiding system and the scripted opener', () => {
    const v = sessionView(session())
    expect(v.log).toEqual([
      { role: 'assistant', text: 'Hi! What should we call your node?' },
      { role: 'user', text: 'Major Oak' },
      { role: 'assistant', text: 'Great name.' },
    ])
    expect(v.draft).toEqual({ nodeName: 'Major Oak' })
  })

  it('skips assistant messages with no text parts (pure tool-call turns)', () => {
    const s = session()
    s.messages.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'x', toolName: 'update_draft', args: {} }] } as never)
    const v = sessionView(s)
    expect(v.log).toHaveLength(3)
  })
})
