// src/adapter/params.ts
// Lenient pickers for operator-supplied adapter params (AdapterContext.strategy).
// The values come from operator-edited strategy config (datanets[id].adapterParams),
// so a wrong-typed field is DROPPED — the adapter's default applies — rather than
// crashing discovery or poisoning an LLM prompt. Validation lives in each adapter's
// own parse function (locality); these are just the shared type guards.
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

export const strArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x): x is string => typeof x === 'string') ? v : undefined
