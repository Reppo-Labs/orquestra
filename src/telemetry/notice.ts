// src/telemetry/notice.ts — the disclosure an operator sees before this node ever
// transmits anything.
//
// This module is the load-bearing difference between "enabled by default" and "covert".
// The gate in consent.ts refuses to transmit while `noticeShown` is false; this is what
// flips it, and it flips it only AFTER the text has actually been printed. Never record
// the notice as shown ahead of printing it — a crash in between would leave a node that
// transmits without ever having disclosed.
//
// A node upgraded from a version that predates telemetry has no consent file, so it reads
// as `noticeShown: false` and gets exactly the same treatment as a fresh install: notice
// on this run, transmission from the next. That is the intended upgrade path, not an edge
// case — operators must not begin transmitting on a `docker pull` they thought was routine.
import { markNoticeShown, needsNotice, OPT_OUT_ENV } from './consent.js'

/** How long the collector retains raw reports. Stated here because the notice must not
 *  promise something the collector does not do — `docs/telemetry.md` and the deployed
 *  retention config are checked against this value (tasks 4.1, 6.5). The exact number is
 *  an open question in design.md; it is defined ONCE here so settling it is a one-line
 *  change rather than a hunt through prose. */
export const RETENTION_DAYS = 90

/** The disclosure text. Deliberately states what is NEVER sent as prominently as what is,
 *  because the operator's first question is not "what do you take" but "do you take my
 *  keys". Also names the inspection command: under default-on, the operator's ability to
 *  verify the claim themselves is what makes the claim worth anything. */
export function noticeText(): string {
  return [
    '',
    '  Orquestra sends anonymous telemetry to help fix bugs for all node operators.',
    '',
    '  Sent:        a random install id, version numbers, OS/arch, error signatures,',
    '               and counts of cycles, votes and mints (attempted vs failed).',
    '  NEVER sent:  your wallet address, private key, strategy, thresholds, datanets,',
    '               balances, earnings, pod content, or RPC URLs.',
    '',
    `  Retained for ${RETENTION_DAYS} days. Nothing has been sent yet — this is the notice.`,
    '',
    '  See exactly what would be sent:  orquestra telemetry --show',
    '  Turn it off permanently:         orquestra telemetry --off',
    `  Turn it off for one run:         ${OPT_OUT_ENV}=1`,
    '',
  ].join('\n')
}

/** Print the notice if it has not been shown, and record that it was. Returns true when
 *  the notice was displayed on this call — the caller uses that only for logging; the
 *  transmission decision belongs to consent.shouldTransmit(), which reads the same record.
 *
 *  Best-effort by design: if recording fails, the notice is shown again next run and the
 *  node stays silent. Failing toward "disclose again, transmit later" is the safe side. */
export function showNoticeIfNeeded(dataDir: string, out: (s: string) => void = console.log): boolean {
  if (!needsNotice(dataDir)) return false
  out(noticeText())
  try {
    markNoticeShown(dataDir)
  } catch (e) {
    console.error(`orquestra: could not record telemetry notice (will re-show next run): ${(e as Error).message}`)
  }
  return true
}
