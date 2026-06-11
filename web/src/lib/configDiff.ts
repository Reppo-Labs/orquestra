// Human-readable diff candidate-vs-baseline (ported from the legacy index.html).
// Added/removed SUBTREES collapse to one line ("datanets.7 added"); leaf changes
// show old→new ("budget.mintReppoMax 50→500").

type Dict = Record<string, unknown>

const isObj = (v: unknown): v is Dict => v != null && typeof v === 'object' && !Array.isArray(v)

const fmtVal = (v: unknown): string => (v === undefined ? '∅' : Array.isArray(v) ? `[${v.join(',')}]` : String(v))

export function configDiff(base: unknown, cand: unknown): string[] {
  const out: string[] = []
  const walk = (a: Dict | undefined, b: Dict | undefined, path: string): void => {
    for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
      if (k === '*') continue // wildcard defaults aren't operator-editable in the grid
      const p = path ? `${path}.${k}` : k
      const av = a ? a[k] : undefined
      const bv = b ? b[k] : undefined
      if (isObj(av) && isObj(bv)) { walk(av, bv, p); continue }
      if (av === undefined && isObj(bv)) { out.push(`${p} added`); continue }
      if (bv === undefined && isObj(av)) { out.push(`${p} removed`); continue }
      if (av !== bv) out.push(`${p} ${fmtVal(av)}→${fmtVal(bv)}`)
    }
  }
  walk(isObj(base) ? base : undefined, isObj(cand) ? cand : undefined, '')
  return out
}
