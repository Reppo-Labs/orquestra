// src/adapter/dedup.ts
import type { CandidatePod } from './types.js'

const norm = (s: string): Set<string> =>
  new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3))

/** Overlap coefficient (inter / smaller set), 0-1, over significant (>3 char) words. */
function overlap(a: string, b: string): number {
  const sa = norm(a), sb = norm(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  // Overlap coefficient (inter / smaller set) — length-robust, so a short reworded claim
  // still matches a longer existing pod name about the same event.
  return inter / Math.min(sa.size, sb.size)
}

/** Backstop dedup: drop a candidate whose text substantially overlaps (>= threshold
 *  overlap coefficient) any existing on-chain pod name. Heuristic, deterministic, LLM-free.
 *  Compares the dataset's CLAIM/TAKE (full text, the unit canonicalKey hashes), not
 *  podName — podName is a short headline whose few significant words are noisy. */
export function filterNovel(candidates: CandidatePod[], existingPodNames: string[], threshold = 0.5): CandidatePod[] {
  const textOf = (c: CandidatePod): string => {
    const d = c.dataset as { claim?: unknown; take?: unknown } | undefined
    const text = d?.claim ?? d?.take
    return typeof text === 'string' && text.length > 0 ? text : c.podName
  }
  return candidates.filter((c) => !existingPodNames.some((e) => overlap(textOf(c), e) >= threshold))
}
