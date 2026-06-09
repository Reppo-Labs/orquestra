// src/minter/select.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CandidatePod, CandidateScorer } from '../adapter/types.js'
import { clampPodName, POD_DESC_MAX } from '../adapter/podName.js'
import type { DatanetRubric } from '../rubric/types.js'
import type { MintIntent } from '../wallet/intents.js'

export interface SelectMintsOpts {
  dataDir: string
  /** mint a candidate only if its LLM score is >= this (1-10). */
  minScore: number
  /** canonical keys already minted (ledger dedup). */
  seenKeys: Set<string>
  scorer: CandidateScorer
  /** optional REPPO cost estimate per mint for the budget. */
  estReppoCost?: number
}

/** Score candidates vs the publisher spec; mint those >= minScore that aren't
 *  already seen. Writes each minted dataset body to disk and references it. */
export async function selectMints(
  datanetId: string,
  candidates: CandidatePod[],
  rubric: DatanetRubric,
  opts: SelectMintsOpts,
): Promise<MintIntent[]> {
  if (!rubric.canMint) return []
  const dataOut = join(opts.dataDir, 'pending-data')
  mkdirSync(dataOut, { recursive: true })
  const seen = new Set(opts.seenKeys)
  const intents: MintIntent[] = []

  for (const c of candidates) {
    if (seen.has(c.canonicalKey)) continue
    seen.add(c.canonicalKey) // dedup within the batch too
    const { score } = await opts.scorer.scoreCandidate(c, rubric)
    if (score < opts.minScore) continue
    const datasetPath = join(dataOut, `mint-${c.canonicalKey}.json`)
    writeFileSync(datasetPath, JSON.stringify(c.dataset))
    intents.push({
      kind: 'mint', datanetId, subnetUuid: rubric.subnetUuid, canonicalKey: c.canonicalKey,
      podName: clampPodName(c.podName), podDescription: clampPodName(c.podDescription, POD_DESC_MAX), datasetPath,
      estReppoCost: opts.estReppoCost ?? 0, selfScore: score,
    })
  }
  return intents
}
