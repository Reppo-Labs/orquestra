// src/collector/rateLimit.ts — per-install admission rate.
//
// Two layers exist, and they defend against different things. API Gateway stage
// throttling caps requests per SOURCE ADDRESS, which is the cheap volumetric defense. This
// module caps them per INSTALL ID, which is the one that matters for the admission
// threshold: an attacker spreading fabricated reports across many addresses still has to
// mint install ids, and each id can only carry so much weight per hour.
//
// Neither layer makes the threshold strong on its own (see the honest note in config.ts).
// Together they make fabricating a widespread-looking fault a sustained effort rather than
// a single curl.
import { MAX_REPORTS_PER_INSTALL_PER_HOUR } from './config.js'

/** Prior activity for one install, supplied by the adapter from storage. */
export interface InstallActivity {
  /** Accepted report timestamps (ms) for this install, most recent first. May be
   *  truncated by the caller — only the last hour is consulted. */
  recentMs: number[]
}

export interface RateDecision {
  allowed: boolean
  /** Accepted reports from this install within the trailing hour, before this one. */
  recentCount: number
}

const HOUR_MS = 60 * 60 * 1000

/** Decide whether one more report from this install may be accepted right now.
 *
 *  A trailing-window count rather than a token bucket: it needs no persisted counter
 *  state, so the adapter can answer it from the same rows it already stores, and there is
 *  no bucket to drift or reset incorrectly. */
export function checkRate(
  activity: InstallActivity,
  nowMs: number,
  maxPerHour: number = MAX_REPORTS_PER_INSTALL_PER_HOUR,
): RateDecision {
  // Future timestamps are ignored rather than trusted: a sender controls its own clock,
  // and counting them would let a burst of future-dated rows mask a present-time flood.
  const recentCount = activity.recentMs.filter((t) => t <= nowMs && nowMs - t < HOUR_MS).length
  return { allowed: recentCount < maxPerHour, recentCount }
}
