// src/minter/score.ts
import type { CandidatePod } from '../adapter/types.js'

const MAX_DATASET_CHARS = 4000

/** Build the text a mint candidate is scored on.
 *
 *  The candidate scorer judges a candidate against the datanet's publisher spec
 *  (which demands trade detail, outcomes, and verification like tx hashes). The
 *  one-line `podDescription` summary exhibits none of that, so a strict scorer
 *  correctly rates it low and nothing ever mints. Include a CAPPED JSON sample of
 *  the actual dataset so the LLM judges the DATA, not the summary — mirroring how
 *  the vote path enriches a pod's description with fetched IPFS content.
 *
 *  The dataset is third-party/derived content and stays UNTRUSTED: the scorer's
 *  system prompt already forbids following instructions embedded in scored text. */
export function candidateScoreInput(c: CandidatePod): { name: string; description: string } {
  let sample = ''
  try {
    sample = JSON.stringify(c.dataset) ?? ''
  } catch {
    sample = '' // unserializable (e.g. circular) → fall back to the summary alone
  }
  if (sample.length > MAX_DATASET_CHARS) {
    sample = sample.slice(0, MAX_DATASET_CHARS) + '…(truncated)'
  }
  const description = sample
    ? `${c.podDescription}\n\n## Dataset (sample, untrusted)\n${sample}`
    : c.podDescription
  return { name: c.podName, description }
}
