// Shared display helpers. Operator-facing rule: never print a raw float
// (`821.91027196`) and never print scientific notation (`1.36e-3`) — an operator
// reading the dashboard must be able to say the number out loud. Every numeric
// value the UI shows goes through one of these.

/** Decimal places by magnitude: big numbers don't need cents, small ones do. */
function decimals(abs: number): number {
  if (abs >= 1000) return 0
  if (abs >= 100) return 1
  if (abs >= 1) return 2
  if (abs >= 0.01) return 4
  return 6
}

/** The one number formatter. Thousands-separated, magnitude-aware rounding, never
 *  scientific: a value too small to render at 6dp degrades to a `<0.000001` bound
 *  rather than a misleading `0` or an unreadable exponent. */
export const fmt = (n: number | undefined | null): string => {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs < 1e-6) return n > 0 ? '<0.000001' : '>-0.000001'
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals(abs), minimumFractionDigits: 0 })
}

/** Whole-number display (pods, votes, tx counts) — never a fraction. */
export const fmtCount = (n: number | undefined | null): string =>
  n === undefined || n === null || !Number.isFinite(n)
    ? '—'
    : Math.round(n).toLocaleString(undefined, { maximumFractionDigits: 0 })

/** Units are never optional on an operator-facing amount. */
export const fmtReppo = (n: number | undefined | null): string => `${fmt(n)} REPPO`
export const fmtEth = (n: number | undefined | null): string => `${fmt(n)} ETH`

/** Money, not tokens: 2dp, with a floor so a real-but-tiny bill never reads $0.00. */
export const fmtUsd = (n: number | undefined | null): string => {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—'
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

/** A 0–1 rate as a percentage. `null` (no attempts) is not 0% — it is unknown. */
export const fmtPct = (rate: number | undefined | null, dp = 0): string =>
  rate === undefined || rate === null || !Number.isFinite(rate) ? '—' : `${(rate * 100).toFixed(dp)}%`

/** Yield per vote. These land anywhere from ~1e3 down to ~1e-4 REPPO, which is what
 *  used to force scientific notation into the UI. Below a thousandth we show a
 *  qualitative bound instead of fake-precise decimals — the exact value belongs in a
 *  `title`, not in the operator's face. */
export const fmtPerVote = (n: number | undefined | null, unit = 'REPPO'): string => {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—'
  if (n === 0) return `0 ${unit}/vote`
  if (Math.abs(n) < 0.001) return `<0.001 ${unit}/vote`
  return `${fmt(n)} ${unit}/vote`
}

export const sign = (n: number): string => (n > 0 ? 'pos' : n < 0 ? 'neg' : '')

/** id → "id · Name" (truncated); falls back to the bare id until names load. */
export const netLabel = (id: string, names: Record<string, string>): string => {
  const n = names[id]
  return n ? `${id} · ${n.length > 30 ? n.slice(0, 29) + '…' : n}` : String(id)
}

export const epochLabel = (e: { epoch: string | number; secondsRemaining: number } | null | undefined): string =>
  e ? `${e.epoch} · ${Math.max(0, Math.round(e.secondsRemaining / 3600))}h left` : '—'
