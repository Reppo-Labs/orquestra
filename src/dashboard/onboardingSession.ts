// src/dashboard/onboardingSession.ts
// Durable onboarding-interview state. The session used to live only in server
// memory ("restart restarts the interview") — which meant every page refresh
// (the UI held the transcript client-side with no way to refetch it) and every
// container restart threw away the operator's answers mid-interview. The
// session now persists to DATA_DIR after every turn and rehydrates on boot;
// GET /api/onboarding/session lets the UI resume where the operator left off.
//
// Not secret material: the transcript is the operator's own chat, served on
// the localhost-only dashboard like every other endpoint (ADR 0002).
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CoreMessage } from 'ai'
import type { OnboardingSession } from './routes.js'
import type { OnboardingSessionView } from './apiTypes.js'

const FILE = 'onboarding-session.json'

const emptySession = (): OnboardingSession => ({ messages: [], draft: null, finalized: null })

/** Load the persisted session, or an empty one. Corrupt/absent files are NOT
 *  fatal — losing a half-finished interview is annoying, not dangerous (unlike
 *  the budget ledger, which refuses to run when corrupt). */
export function loadOnboardingSession(dataDir: string): OnboardingSession {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, FILE), 'utf8')) as Partial<OnboardingSession>
    if (!Array.isArray(raw.messages)) return emptySession()
    return {
      messages: raw.messages as CoreMessage[],
      draft: raw.draft ?? null,
      finalized: raw.finalized ?? null,
    }
  } catch {
    return emptySession()
  }
}

/** Persist after each turn. Write-then-rename so a crash mid-write never
 *  leaves a truncated file (load tolerates it anyway, but cheap to avoid).
 *  Best-effort: a failed save must never fail the chat turn itself. */
export function saveOnboardingSession(dataDir: string, session: OnboardingSession): void {
  try {
    const tmp = join(dataDir, `${FILE}.tmp`)
    writeFileSync(tmp, JSON.stringify(session))
    renameSync(tmp, join(dataDir, FILE))
  } catch (e) {
    console.error(`orquestra: onboarding session save failed (interview continues, refresh may lose it): ${(e as Error).message}`)
  }
}

/** Drop the persisted session (explicit reset, or config confirmed). */
export function clearOnboardingSession(dataDir: string): void {
  try { rmSync(join(dataDir, FILE), { force: true }) } catch { /* best-effort */ }
}

export type { OnboardingSessionView } from './apiTypes.js'

/** The scripted opener (seedOnboardingMessages) — an internal prompt, not
 *  something the operator typed; hidden from the resumed transcript. */
const SEED_USER_PREFIX = 'Begin onboarding.'

/** Project the raw CoreMessage transcript to displayable chat bubbles:
 *  operator lines + assistant text, skipping system/tool traffic. */
export function sessionView(session: OnboardingSession): OnboardingSessionView {
  const log: OnboardingSessionView['log'] = []
  for (const m of session.messages) {
    if (m.role === 'user' && typeof m.content === 'string') {
      if (m.content.startsWith(SEED_USER_PREFIX)) continue
      log.push({ role: 'user', text: m.content })
    } else if (m.role === 'assistant') {
      const text = typeof m.content === 'string'
        ? m.content
        : m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
      if (text.trim()) log.push({ role: 'assistant', text })
    }
  }
  return { log, draft: session.draft, finalized: session.finalized }
}
