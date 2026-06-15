// src/adapter/dedup.ts
import type { CandidatePod } from './types.js'

const norm = (s: string): Set<string> =>
  new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3))

/** Minimum number of shared significant words for the overlap coefficient to count
 *  as a duplicate. Without this, two SHORT texts sharing just 2 common topic words
 *  (e.g. "Celtics defense collapse" vs "Celtics offense collapse" — celtics+collapse,
 *  coeff 0.67) would be wrongly collapsed, dropping a distinct claim. Since this is
 *  only a backstop (the on-chain idempotency key is the real dedup), prefer a false
 *  negative (keep a near-dup) over a false positive (drop a distinct, mintable claim). */
const MIN_SHARED_WORDS = 3

/** Overlap coefficient (inter / smaller set) plus the absolute intersection count. */
function overlapStats(a: string, b: string): { coeff: number; inter: number } {
  const sa = norm(a), sb = norm(b)
  if (sa.size === 0 || sb.size === 0) return { coeff: 0, inter: 0 }
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  // Overlap coefficient (inter / smaller set) — length-robust, so a short reworded claim
  // still matches a longer existing pod name about the same event.
  return { coeff: inter / Math.min(sa.size, sb.size), inter }
}

/** Backstop dedup: drop a candidate whose text substantially overlaps an existing
 *  on-chain pod name — both a high overlap coefficient (>= threshold) AND at least
 *  MIN_SHARED_WORDS shared significant words. Heuristic, deterministic, LLM-free.
 *  Compares the dataset's CLAIM/TAKE (full text, the unit canonicalKey hashes), not
 *  podName — podName is a short headline whose few significant words are noisy. */
export function filterNovel(candidates: CandidatePod[], existingPodNames: string[], threshold = 0.5): CandidatePod[] {
  const textOf = (c: CandidatePod): string => {
    const d = c.dataset as { claim?: unknown; take?: unknown } | undefined
    const text = d?.claim ?? d?.take
    return typeof text === 'string' && text.length > 0 ? text : c.podName
  }
  const isDup = (text: string, existing: string): boolean => {
    const { coeff, inter } = overlapStats(text, existing)
    return coeff >= threshold && inter >= MIN_SHARED_WORDS
  }
  return candidates.filter((c) => !existingPodNames.some((e) => isDup(textOf(c), e)))
}
