// src/collector/aggregate.ts — turning stored reports into something a consumer may see.
//
// This is the gate the whole ingest design rests on. Reports arrive unauthenticated, so an
// individual one proves nothing; a signal earns trust only by appearing independently
// across MIN_DISTINCT_INSTALLS installs inside WINDOW_DAYS.
//
// Two rules, both enforced here rather than downstream:
//   1. Count DISTINCT INSTALLS, never reports. One install shouting a thousand times is
//      still one install, and counting reports would make the threshold trivially
//      defeatable by a loop.
//   2. Emit counts and closed-set values only. No string that originated in a report ever
//      reaches a consumer — the signature key is REBUILT from validated components here,
//      not passed through. Consumers of this output are expected to include automated
//      ones, so anything shaped like an instruction must be structurally absent, not
//      filtered.
import { MIN_DISTINCT_INSTALLS, WINDOW_DAYS } from './config.js'
import type { StoredReport } from './validate.js'

/** A stored row as the collector holds it. `receivedAt` is stamped by the collector on
 *  acceptance and is the ONLY timestamp aggregation may use: `ts` comes from the sender,
 *  who controls their own clock and has an incentive to lie about it. Windowing on a
 *  reporter-supplied field would let one keep a fabricated signal inside the window
 *  indefinitely — the window is a security bound, so it must be measured by our clock. */
export interface PersistedReport extends StoredReport {
  receivedAt: string
}

/** A fault, with the evidence that it is real. `installs` is the trust signal. */
export interface SignalAggregate {
  /** Rebuilt from validated components — never a string taken from a report. */
  signature: string
  errorClass: string
  frames: string[]
  installs: number
  /** Total occurrences across those installs. Reported for ranking only; the ADMISSION
   *  decision uses `installs` alone, or a single noisy install could force a signal in. */
  occurrences: number
  firstSeen: string
  lastSeen: string
}

export interface FleetAggregate {
  /** Distinct installs that reported anything in the window — the fleet size estimate. */
  installs: number
  reports: number
  /** Summed counts across the window. Only meaningful in aggregate; never per-install. */
  cycles: number
  votesAttempted: number
  votesFailed: number
  mintsAttempted: number
  mintsFailed: number
  refusedBudget: number
}

export interface AggregationResult {
  windowDays: number
  minDistinctInstalls: number
  fleet: FleetAggregate
  /** Only signals at or above the threshold. Everything else is withheld entirely —
   *  not returned with a flag, since a flag invites a caller to ignore it. */
  signals: SignalAggregate[]
  /** How many distinct signals existed but did NOT meet the threshold. A count only:
   *  naming them would leak exactly the sub-threshold data the gate exists to withhold. */
  withheld: number
}

/** Canonical key for a fault. Built from validated `errorClass` and `frames`, which
 *  validate.ts has already constrained to a safe character class — so this string is ours,
 *  not the reporter's. */
export function signatureKey(errorClass: string, frames: string[]): string {
  return [errorClass, ...frames].join(' | ')
}

function withinWindow(ts: string, nowMs: number, windowDays: number): boolean {
  const t = Date.parse(ts)
  if (Number.isNaN(t)) return false
  // Future-dated reports are excluded: a sender controls its own clock, and accepting
  // them would let one keep a signal alive past the window indefinitely.
  if (t > nowMs) return false
  return nowMs - t <= windowDays * 24 * 60 * 60 * 1000
}

export interface AggregateOptions {
  now?: number
  windowDays?: number
  minDistinctInstalls?: number
}

/** Aggregate stored reports into consumer-facing output.
 *
 *  Pure and synchronous: the AWS adapter is responsible for fetching the window's rows,
 *  this decides what may be said about them. Keeping the gate in a pure function is what
 *  makes it testable, and an untestable admission control is not one. */
export function aggregate(reports: PersistedReport[], opts: AggregateOptions = {}): AggregationResult {
  const now = opts.now ?? Date.now()
  const windowDays = opts.windowDays ?? WINDOW_DAYS
  const minInstalls = opts.minDistinctInstalls ?? MIN_DISTINCT_INSTALLS

  // receivedAt, not ts — see PersistedReport.
  const inWindow = reports.filter((r) => withinWindow(r.receivedAt, now, windowDays))

  const fleetInstalls = new Set<string>()
  const fleet: FleetAggregate = {
    installs: 0, reports: 0, cycles: 0,
    votesAttempted: 0, votesFailed: 0, mintsAttempted: 0, mintsFailed: 0, refusedBudget: 0,
  }

  // signature -> { installs, occurrences, first/last seen, and the components to rebuild
  // the key from }. A Map keyed by the derived string, values holding a Set of installs.
  const bySig = new Map<
    string,
    { errorClass: string; frames: string[]; installs: Set<string>; occurrences: number; first: string; last: string }
  >()

  for (const r of inWindow) {
    fleetInstalls.add(r.installId)
    fleet.reports += 1
    fleet.cycles += r.counts.cycles
    fleet.votesAttempted += r.counts.votes.attempted
    fleet.votesFailed += r.counts.votes.failed
    fleet.mintsAttempted += r.counts.mints.attempted
    fleet.mintsFailed += r.counts.mints.failed
    fleet.refusedBudget += r.counts.refusedBudget

    for (const sig of r.errorSignatures) {
      const key = signatureKey(sig.errorClass, sig.frames)
      const existing = bySig.get(key)
      if (existing === undefined) {
        bySig.set(key, {
          errorClass: sig.errorClass, frames: sig.frames,
          installs: new Set([r.installId]), occurrences: 1, first: r.receivedAt, last: r.receivedAt,
        })
      } else {
        existing.installs.add(r.installId)
        existing.occurrences += 1
        if (r.receivedAt < existing.first) existing.first = r.receivedAt
        if (r.receivedAt > existing.last) existing.last = r.receivedAt
      }
    }
  }

  fleet.installs = fleetInstalls.size

  const signals: SignalAggregate[] = []
  let withheld = 0
  for (const [key, v] of bySig) {
    if (v.installs.size < minInstalls) {
      withheld += 1
      continue
    }
    signals.push({
      signature: key,
      errorClass: v.errorClass,
      frames: v.frames,
      installs: v.installs.size,
      occurrences: v.occurrences,
      firstSeen: v.first,
      lastSeen: v.last,
    })
  }

  // Most independently-corroborated first — installs, not occurrences, so a loud single
  // install cannot outrank a genuinely widespread fault.
  signals.sort((a, b) => b.installs - a.installs || b.occurrences - a.occurrences)

  return { windowDays, minDistinctInstalls: minInstalls, fleet, signals, withheld }
}
