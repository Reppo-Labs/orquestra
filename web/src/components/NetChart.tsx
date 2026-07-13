// Profit/loss OVER TIME. The verdict ("Losing 1,906 REPPO") tells an operator where they
// are; only the trend tells them whether to act. A loss that is recovering needs patience;
// the same loss accelerating needs a decision today. That is the whole reason this exists.
//
// Inline SVG, no chart library (none is in web/package.json, and none is being added).
//
// HONESTY RULES BAKED INTO THE GEOMETRY
// - Zero is ALWAYS in the y-domain, so a loss is drawn BELOW a visible zero line. A chart
//   auto-scaled to a purely negative range would show a loss climbing cheerfully upward.
// - Green above zero, red below — the Phase-1 colour rule (green/red = profit/loss only).
//   The line itself is neutral; the FILL carries the sign.
// - Insufficient data draws NOTHING. A flat line through one point is a claim about a
//   history we do not have.
import type { NetSeries } from '../lib/pnlSeries'
import { fmt, fmtReppo } from '../lib/format'

const W = 640
const H = 132
const PAD_T = 10
const PAD_B = 18
const PAD_X = 2

const shortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** The chart, or an honest statement that there is not enough history for one. */
export function NetChart({ series }: { series: NetSeries | null }) {
  // No authoritative anchor (fresh node, no /api/pnl): EarnBanner already says "waiting for
  // the first cycle". A second empty box would just be furniture.
  if (!series) return null

  const { points, current, claimable, insufficient, summary, trend, windowed } = series
  const tone = current > 0 ? 'pos' : current < 0 ? 'neg' : ''

  // Emissions that are DUE but never claimed have no timestamp, so they cannot sit on the
  // curve without inventing a moment they arrived. They are stated beside it instead — the
  // node is owed this, and it has not got it yet.
  const owed = claimable > 0
    ? <span className="nc-owed muted"> · {fmtReppo(claimable)} due, not yet claimed</span>
    : null

  // Not enough history to draw a trend — say so, and still show the value. The text fallback
  // is not a degraded mode here; it is the honest mode.
  if (insufficient) {
    return (
      <figure className="netchart empty">
        <figcaption className="nc-caption">
          <span className="nc-title">Profit over time</span>
          <span className={`nc-now mono tnum ${tone}`}>{fmtReppo(current)}</span>
          {owed}
        </figcaption>
        <div className="nc-empty muted" role="status">{summary}</div>
      </figure>
    )
  }

  // Zero is always in view: the sign of the number is the entire point of the chart.
  const nets = points.map((p) => p.net)
  const rawMin = Math.min(0, ...nets)
  const rawMax = Math.max(0, ...nets)
  // A flat series would collapse the domain to zero height and divide by zero.
  const span = rawMax - rawMin || Math.max(1, Math.abs(current))
  const padY = span * 0.12
  const yMin = rawMin - padY
  const yMax = rawMax + padY

  const t0 = points[0].t
  const t1 = points[points.length - 1].t
  const tSpan = t1 - t0 || 1

  const x = (t: number): number => PAD_X + ((t - t0) / tSpan) * (W - PAD_X * 2)
  const y = (n: number): number => PAD_T + ((yMax - n) / (yMax - yMin)) * (H - PAD_T - PAD_B)

  const zeroY = y(0)
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(2)},${y(p.net).toFixed(2)}`).join(' ')
  // Area between the curve and the zero baseline. Drawn twice, clipped above/below zero, so a
  // series that CROSSES zero is coloured correctly on both sides without hand-splitting it.
  const area = `${line} L${x(t1).toFixed(2)},${zeroY.toFixed(2)} L${x(t0).toFixed(2)},${zeroY.toFixed(2)} Z`
  const last = points[points.length - 1]

  return (
    <figure className={`netchart ${trend}`}>
      <figcaption className="nc-caption">
        <span className="nc-title">Profit over time</span>
        <span className={`nc-now mono tnum ${tone}`}>{fmtReppo(current)}</span>
        <span className="nc-trend muted">
          {trend === 'worsening' ? 'getting worse' : trend === 'improving' ? 'recovering' : 'flat'}
        </span>
        {owed}
      </figcaption>

      {/* role=img + aria-label: the whole trend, in words, for anyone who cannot see it. */}
      <svg
        className="nc-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
      >
        <defs>
          {/* y grows downward, so loss is BELOW the zero line. */}
          <clipPath id="nc-clip-loss">
            <rect x="0" y={zeroY} width={W} height={Math.max(0, H - zeroY)} />
          </clipPath>
          <clipPath id="nc-clip-profit">
            <rect x="0" y="0" width={W} height={Math.max(0, zeroY)} />
          </clipPath>
        </defs>

        {/* Green above, red below — profit/loss and nothing else. */}
        <path d={area} className="nc-area profit" clipPath="url(#nc-clip-profit)" />
        <path d={area} className="nc-area loss" clipPath="url(#nc-clip-loss)" />

        {/* The zero line, always drawn: "below this line you are down money". */}
        <line x1="0" y1={zeroY} x2={W} y2={zeroY} className="nc-zero" vectorEffect="non-scaling-stroke" />

        <path d={line} className="nc-line" vectorEffect="non-scaling-stroke" />
        <circle cx={x(last.t)} cy={y(last.net)} r="3" className={`nc-dot ${tone}`} vectorEffect="non-scaling-stroke" />
      </svg>

      {/* The axis, in words an operator reads rather than decodes. `windowed` is the honest
          caveat: the activity log is a capped window, so this is not "all time". */}
      <div className="nc-axis muted">
        <span>{shortDate(series.fromMs)}</span>
        <span className="nc-zero-key">
          0 = break even · {fmt(series.first)} → {fmt(current)} REPPO claimed − spent{windowed ? ' · recent history only' : ''}
        </span>
        <span>{shortDate(series.toMs)}</span>
      </div>

      {/* The text fallback, visible to everyone. A chart nobody can read is decoration. */}
      <p className="nc-summary muted">{summary}</p>
    </figure>
  )
}
