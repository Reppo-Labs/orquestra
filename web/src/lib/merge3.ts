// A three-way merge for the strategy config.
//
// WHY THE DASHBOARD NEEDS ONE
// The candidate (the config the operator is editing) is loaded once and POSTed whole. But
// the node's config is NOT owned by this tab: accepting a learning proposal writes it
// server-side, POST /api/pause writes it, another tab writes it. Without a rebase, the next
// Save re-persists a copy of the config from page load and silently reverts all of that —
// a datanet quietly back to `aggressive`, a pause quietly lifted.
//
// So on every poll we rebase: `base` is the config we last knew the server held, `mine` is
// the candidate with the operator's unsaved edits on top of it, and `theirs` is the config
// the server holds now. Fields the operator never touched take the SERVER's value; fields
// they did touch keep theirs. Neither side is silently dropped.
//
// JSON only (the config is a JSON document). Arrays are atomic — a config array has no
// stable element identity to merge on, so whoever changed it wins, operator first.

export type Json = unknown

const isObj = (v: Json): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Structural equality over JSON values. */
export function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

/**
 * Merge `theirs` (the server's config now) into `mine` (the operator's candidate), relative
 * to `base` (what the server held when the candidate was last in sync).
 *
 * Per key:
 *  - the operator did not touch it  → take THEIRS (the node's newer value wins)
 *  - the server did not touch it    → keep MINE (their unsaved edit survives)
 *  - both changed, both objects     → recurse
 *  - both changed, a leaf           → keep MINE. The operator is looking at the screen; a
 *                                     silent overwrite of what they just typed is worse than
 *                                     a conflict they can see in the diff line.
 * `undefined` means "key absent", so a key the operator DELETED stays deleted.
 */
export function merge3(base: Json, mine: Json, theirs: Json): Json {
  if (deepEqual(mine, base)) return theirs // untouched by the operator → adopt the server's
  if (deepEqual(theirs, base)) return mine // untouched by the server → keep the edit
  if (isObj(base) && isObj(mine) && isObj(theirs)) {
    const out: Record<string, Json> = {}
    const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])
    for (const k of keys) {
      const v = merge3(base[k], mine[k], theirs[k])
      if (v !== undefined) out[k] = v
    }
    return out
  }
  return mine // conflicting leaves (or shape change): the operator's intent wins, visibly
}
