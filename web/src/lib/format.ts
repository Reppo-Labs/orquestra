// Shared display helpers (ported verbatim from the legacy index.html).

export const fmt = (n: number | undefined | null): string =>
  n === undefined || n === null ? '—' : (Math.round(n * 10000) / 10000).toLocaleString()

export const sign = (n: number): string => (n > 0 ? 'pos' : n < 0 ? 'neg' : '')

/** +142% / −38.4% — percentage return, sign always explicit so a positive read is
 *  unmistakable next to the dollar figure. Sub-10% keeps a decimal; a huge early
 *  ratio (tiny cost basis) is capped in text so the card never wraps. */
export const pct = (n: number): string => {
  const abs = Math.abs(n)
  if (abs >= 100000) return `${n < 0 ? '−' : '+'}>99,999%`
  const digits = abs < 10 ? 1 : 0
  return `${n < 0 ? '−' : '+'}${abs.toFixed(digits)}%`
}

/** id → "id · Name" (truncated); falls back to the bare id until names load. */
export const netLabel = (id: string, names: Record<string, string>): string => {
  const n = names[id]
  return n ? `${id} · ${n.length > 30 ? n.slice(0, 29) + '…' : n}` : String(id)
}

export const epochLabel = (e: { epoch: string | number; secondsRemaining: number } | null | undefined): string =>
  e ? `${e.epoch} · ${Math.max(0, Math.round(e.secondsRemaining / 3600))}h left` : '—'
