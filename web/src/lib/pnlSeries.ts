// Profit/loss OVER TIME, derived entirely client-side from data the node already serves.
//
// WHY THIS IS NOT A CUMULATIVE SUM OF THE ACTIVITY LOG
// ----------------------------------------------------
// `/api/activity` is a capped window — the server hard-codes `readActivity(dataDir,
// { limit: 500 })` and ignores any limit param. The backend explicitly warns about this
// (src/dashboard/activityLog.ts): "PnL must use this rather than summing a readActivity
// slice — a capped read drops old claims while cumulative mint spend is never truncated,
// making net REPPO read falsely negative."
//
// So we do NOT accumulate from zero. We ANCHOR to an authoritative lifetime figure and
// integrate BACKWARDS through the window's money events:
//
//     net(after event i) = netNow − Σ deltas of every event after i
//
// Every plotted point is therefore the node's true net REPPO at that instant, not a
// partial sum of a truncated log. What the window cannot tell us is the level BEFORE its
// oldest event — and we never claim to: the chart starts where the window starts and says
// so ("since <date>"), rather than implying the node began at zero.
//
// WHICH LIFETIME FIGURE — AND WHY NOT `netReppo`
// ---------------------------------------------
// The anchor must be the sum the DELTAS actually add up to, and the deltas are exactly the
// backend's two lifetime money sums:
//   spent  = executed 'mint'  rows, reppoSpent
//   earned = executed 'claim' rows, reppoClaimed
// i.e. REALIZED = claimedReppo − spentReppo.
//
// `pnl.netReppo` is NOT that. src/dashboard/pnl.ts defines earnedReppo = claimedReppo +
// claimableReppo, so netReppo silently includes CLAIMABLE — emissions that are due but have
// never been claimed. Claimable is a point-in-time balance with no activity row and thus no
// delta, so anchoring to netReppo shifts the WHOLE curve up by today's unclaimed balance and
// retro-projects that credit onto instants when the node had not earned it. A node that has
// claimed nothing, spent 600, and has 900 pending would be drawn entirely ABOVE the zero
// line — a green, profitable chart for a node whose realized position was never once
// positive. So: anchor on realized, and surface `claimable` SEPARATELY (the chart says how
// much is still to come; it does not pretend it already arrived).
//
// Gas (ETH) is deliberately excluded — the REPPO sums exclude it too, and mixing units would
// make the chart's own arithmetic a lie.
import type { ActivityRow, Pnl } from '../api'
import { fmtReppo } from './format'

/** One instant, and the node's true net REPPO at that instant. */
export interface NetPoint {
  t: number
  net: number
}

export type Trend = 'improving' | 'worsening' | 'flat'

export interface NetSeries {
  /** Oldest → newest. One point per money event. Empty when `insufficient`. */
  points: NetPoint[]
  /** The REALIZED lifetime net (claimedReppo − spentReppo) — what the last point equals.
   *  Money that has actually moved, and the only level the deltas can support. */
  current: number
  /** Emissions due but never claimed (pnl.claimableReppo). NOT in `current` and NOT plotted:
   *  it has no timestamp, so it cannot be placed on a curve without inventing history. Shown
   *  beside the chart as what is still owed. */
  claimable: number
  /** Net at the first PLOTTED point, i.e. immediately AFTER the window's first money event.
   *  This is what the chart draws from. */
  first: number
  /** Net immediately BEFORE the window's first money event (exact: current − Σ all deltas).
   *  Distinct from `first`, and load-bearing: rate maths must measure the earlier half from
   *  here, or the first event's delta is silently dropped and a perfectly STEADY loss reads
   *  as an accelerating one. Not plotted — we cannot draw a level whose timestamp we don't
   *  know, only compute from it. */
  baseline: number
  /** current − first, over the window only. */
  change: number
  trend: Trend
  /** Money events (executed mints + claims) found in the window. */
  events: number
  fromMs: number
  toMs: number
  /** Fewer than two money events: there is no trend to draw. The UI MUST NOT render a
   *  line here — a flat line across an empty chart is a claim we cannot support. */
  insufficient: boolean
  /** The window is a capped slice, so the series starts mid-history rather than at the
   *  node's first ever action. Drives the "since <date>" caption. */
  windowed: boolean
  /** The trend in words — the chart's accessible name and its text fallback. */
  summary: string
}

interface MoneyEvent {
  t: number
  delta: number
}

/** Executed money movements only, oldest-first. A refused/errored mint moved no REPPO and
 *  a claim with no amount is not money — neither may bend the curve. */
function moneyEvents(activity: ActivityRow[]): MoneyEvent[] {
  const out: MoneyEvent[] = []
  for (const r of activity) {
    if (r.status !== 'executed') continue
    const t = new Date(r.ts).getTime()
    if (!Number.isFinite(t)) continue
    if (r.kind === 'mint') {
      const spent = r.reppoSpent
      // Pre-migration mint rows carry no reppoSpent. They are NOT free mints — we simply
      // cannot price them, so they contribute no delta (exactly as the backend's
      // COALESCE(SUM(reppoSpent), 0) treats them) and the anchor keeps the totals honest.
      if (typeof spent === 'number' && Number.isFinite(spent) && spent > 0) out.push({ t, delta: -spent })
    } else if (r.kind === 'claim') {
      const got = r.reppoClaimed
      if (typeof got === 'number' && Number.isFinite(got) && got > 0) out.push({ t, delta: got })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

const trendOf = (change: number): Trend => (change > 0 ? 'improving' : change < 0 ? 'worsening' : 'flat')

/** Plain-English trend, used as the chart's aria-label AND its visible caption. A chart an
 *  operator cannot see must still be readable; a chart they CAN see should not need decoding. */
function describe(current: number, change: number, days: number, events: number, claimable: number): string {
  const whole = Math.round(days)
  const when = days >= 1 ? `over the last ${whole} day${whole === 1 ? '' : 's'}` : 'over the last few hours'
  const level = current < 0
    ? `down ${fmtReppo(-current)} overall`
    : current > 0 ? `up ${fmtReppo(current)} overall` : 'breaking even overall'
  // Unclaimed emissions are money the node is OWED, not money it has. Stating them here —
  // outside the level, never folded into it — is how the chart stays honest without hiding
  // the good news.
  const owed = claimable > 0 ? ` A further ${fmtReppo(claimable)} is due but not yet claimed, and is not counted above.` : ''
  if (change < 0) return `Realized REPPO ${when}: ${level}, and falling — it lost a further ${fmtReppo(-change)} across ${events} money events in this window.${owed}`
  if (change > 0) return `Realized REPPO ${when}: ${level}, and recovering — it gained ${fmtReppo(change)} back across ${events} money events in this window.${owed}`
  return `Realized REPPO ${when}: ${level}, unchanged across ${events} money events in this window.${owed}`
}

/** The activity window is a capped slice (server: limit 500). At the cap we must assume
 *  older history was cut off. */
const WINDOW_CAP = 500

/**
 * Build the net-REPPO-over-time series. Returns null when there is no authoritative
 * anchor (`pnl` absent — a fresh node), because without it every level would be a guess.
 */
export function buildNetSeries(
  activity: ActivityRow[],
  pnl: Pnl | null | undefined,
  opts: { windowCap?: number } = {},
): NetSeries | null {
  // REALIZED, not netReppo (see the file header): the anchor must be the sum the deltas add
  // up to, or every plotted level is shifted by today's unclaimed balance.
  if (!pnl || !Number.isFinite(pnl.claimedReppo) || !Number.isFinite(pnl.spentReppo)) return null
  const cap = opts.windowCap ?? WINDOW_CAP
  const events = moneyEvents(activity)
  const current = pnl.claimedReppo - pnl.spentReppo
  const claimable = Number.isFinite(pnl.claimableReppo) ? pnl.claimableReppo : 0
  const windowed = activity.length >= cap

  // 0 or 1 money events: there is a value, but there is no TREND. Say so; draw nothing.
  if (events.length < 2) {
    return {
      points: [],
      current,
      claimable,
      first: current,
      baseline: current - (events[0]?.delta ?? 0),
      change: 0,
      trend: 'flat',
      events: events.length,
      fromMs: events[0]?.t ?? 0,
      toMs: events[0]?.t ?? 0,
      insufficient: true,
      windowed,
      summary: events.length === 0
        ? 'No mints or claims yet — there is no profit history to chart.'
        : 'Only one money event so far — not enough history to show a trend yet.',
    }
  }

  // Integrate BACKWARDS from the authoritative lifetime net (see file header).
  const points: NetPoint[] = new Array(events.length)
  let running = current
  for (let i = events.length - 1; i >= 0; i--) {
    points[i] = { t: events[i].t, net: running }
    running -= events[i].delta
  }
  // `running` has now walked past the OLDEST event: the exact level the node was at before
  // this window began.
  const baseline = running
  const first = points[0].net
  const change = current - first
  const fromMs = points[0].t
  const toMs = points[points.length - 1].t
  const days = (toMs - fromMs) / 86_400_000

  return {
    points,
    current,
    claimable,
    first,
    baseline,
    change,
    trend: trendOf(change),
    events: events.length,
    fromMs,
    toMs,
    insufficient: false,
    windowed,
    summary: describe(current, change, days, events.length, claimable),
  }
}

export interface LossRate {
  /** REPPO per day in the newer half of the window (negative = losing). */
  recentPerDay: number
  /** REPPO per day in the older half. */
  earlierPerDay: number
  /** Losing money, and losing it FASTER than before. */
  accelerating: boolean
}

/** Net at time `t` — the level after the last event at or before `t`. */
function netAt(points: NetPoint[], t: number): number {
  let net = points[0].net
  for (const p of points) {
    if (p.t > t) break
    net = p.net
  }
  return net
}

/**
 * Is the loss getting WORSE? Splits the window at its midpoint in TIME (not in event
 * count — events cluster) and compares the two REPPO/day rates.
 *
 * Only ever true when the node is actually down (current < 0): a profitable node whose
 * gains merely slowed is not "bleeding faster", and calling it that would be the same
 * dishonesty this dashboard exists to remove. Needs ≥4 events so neither half is a
 * single point.
 */
export function lossAcceleration(s: NetSeries | null): LossRate | null {
  if (!s || s.insufficient || s.events < 4) return null
  const span = s.toMs - s.fromMs
  if (span <= 0) return null

  const mid = s.fromMs + span / 2
  const halfDays = span / 2 / 86_400_000
  if (halfDays <= 0) return null

  const netMid = netAt(s.points, mid)
  // The earlier half is measured from `baseline` (the level BEFORE the window's first event),
  // NOT from `first` (the level after it). Measuring from `first` drops the first event's
  // delta entirely, which makes a perfectly steady loss look like it is accelerating — the
  // exact false alarm this function exists to avoid raising.
  const earlierPerDay = (netMid - s.baseline) / halfDays
  const recentPerDay = (s.current - netMid) / halfDays

  // "Accelerating" = the recent burn rate is materially worse than the earlier one.
  // Comparing against min(earlier, 0) makes a swing from GAINING to LOSING count as
  // acceleration too, instead of being masked by a positive baseline.
  const accelerating = s.current < 0 && recentPerDay < 0 && recentPerDay < Math.min(earlierPerDay, 0) * 1.25
  return { recentPerDay, earlierPerDay, accelerating }
}
