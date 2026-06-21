// src/voter/allocate.ts — split a finite per-cycle vote count across datanets by weight.
// Pure largest-remainder (Hamilton) apportionment: every datanet gets floor(ideal), then the
// leftover slots go to the largest fractional remainders, ties broken by datanet id ascending
// so the result is deterministic. The returned slots always sum to `total`.

/** Apportion `total` integer vote slots across `weights` (datanetId → positive weight).
 *  Only ratios matter (3:1 == 30:10). Empty weights → empty map. total === 0 → all zero. */
export function allocateVoteSlots(weights: Map<string, number>, total: number): Map<string, number> {
  const ids = [...weights.keys()]
  const out = new Map<string, number>(ids.map((id) => [id, 0]))
  if (ids.length === 0 || total <= 0) return out

  const totalWeight = [...weights.values()].reduce((a, w) => a + w, 0)
  if (totalWeight <= 0) return out

  // floor(ideal) per datanet, tracking the fractional remainder for the leftover pass.
  const remainders: { id: string; frac: number }[] = []
  let assigned = 0
  for (const id of ids) {
    const ideal = (total * (weights.get(id) ?? 0)) / totalWeight
    const floor = Math.floor(ideal)
    out.set(id, floor)
    assigned += floor
    remainders.push({ id, frac: ideal - floor })
  }

  // Distribute the leftover slots to the largest remainders; ties → id ascending (stable).
  let leftover = total - assigned
  remainders.sort((a, b) => b.frac - a.frac || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (let i = 0; leftover > 0 && i < remainders.length; i++, leftover--) {
    const { id } = remainders[i]
    out.set(id, (out.get(id) ?? 0) + 1)
  }
  return out
}
