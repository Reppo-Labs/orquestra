// Shared display helpers (ported verbatim from the legacy index.html).

export const fmt = (n: number | undefined | null): string =>
  n === undefined || n === null ? '—' : (Math.round(n * 10000) / 10000).toLocaleString()

export const sign = (n: number): string => (n > 0 ? 'pos' : n < 0 ? 'neg' : '')

/** id → "id — Name" (truncated); falls back to the bare id until names load. */
export const netLabel = (id: string, names: Record<string, string>): string => {
  const n = names[id]
  return n ? `${id} — ${n.length > 30 ? n.slice(0, 29) + '…' : n}` : String(id)
}

export const epochLabel = (e: { epoch: string | number; secondsRemaining: number } | null | undefined): string =>
  e ? `${e.epoch} · ${Math.max(0, Math.round(e.secondsRemaining / 3600))}h left` : '—'
