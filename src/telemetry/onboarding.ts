// src/telemetry/onboarding.ts — the telemetry disclosure inside the onboarding interview.
//
// Onboarding is the one moment an operator is already reading carefully, so it is where
// the default is stated plainly and turning it off costs one keystroke. Note the framing:
// this is a DISCLOSURE with an immediate opt-out, not a consent request. Telemetry is on
// by default (specs/telemetry-consent), and dressing that up as a question the operator
// "agreed to" would misrepresent what happened.
//
// Answering here also satisfies the notice gate — the operator has demonstrably been
// shown what is collected — so a node configured through onboarding may transmit from its
// first cycle rather than waiting a run.
import { markNoticeShown, setTelemetryEnabled } from './consent.js'
import { noticeText } from './notice.js'

/** The slice of the onboarding Prompter this needs. Structurally typed so it accepts the
 *  real Prompter without importing the onboarding module (which would couple telemetry to
 *  the interview, and telemetry must stay removable). */
export interface DisclosurePrompter {
  ask(question: string, def?: string): Promise<string>
  info(message: string): void
}

/** True when an answer means "turn it off". Accepts the obvious spellings; anything else
 *  (including empty, i.e. the operator hit enter) leaves the default in place. */
function meansNo(answer: string): boolean {
  return ['n', 'no', 'off', 'disable', 'disabled', 'false'].includes(answer.trim().toLowerCase())
}

/** Show the disclosure, offer an immediate opt-out, and record the outcome.
 *  Returns the resulting enabled state. */
export async function discloseTelemetry(dataDir: string, p: DisclosurePrompter): Promise<boolean> {
  p.info(noticeText())
  const answer = await p.ask('Keep anonymous telemetry enabled? [Y/n]', 'Y')
  const enabled = !meansNo(answer)

  setTelemetryEnabled(dataDir, enabled)
  // Record the notice AFTER the decision, so a throw above leaves the node in the
  // "not yet disclosed" state and it re-discloses rather than silently transmitting.
  markNoticeShown(dataDir)

  p.info(
    enabled
      ? 'Telemetry enabled. Turn it off any time with `orquestra telemetry --off`.'
      : 'Telemetry disabled. Nothing will be transmitted.',
  )
  return enabled
}
