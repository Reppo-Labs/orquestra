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
    // Per-candidate isolation (parity with selectVotes): a single candidate's
    // scoring failure — including a panel that could not reach a verdict — skips
    // THAT candidate, not the whole datanet's mint batch.
    let result: { score: number; reason?: string; panel?: MintIntent['panel'] }
    try {
      result = await opts.scorer.scoreCandidate(c, rubric)
    } catch (e) {
      console.error(`orquestra: mint candidate ${c.canonicalKey} (datanet ${datanetId}) scoring failed, skipped — ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const { score, reason, panel } = result
    if (score < opts.minScore) continue
    const datasetPath = join(dataOut, `mint-${c.canonicalKey}.json`)
    // The dataset write is inside the per-candidate isolation too: a single disk
    // failure skips THAT candidate, it does not abort the whole datanet's batch.
    try {
      writeFileSync(datasetPath, JSON.stringify(c.dataset))
    } catch (e) {
      console.error(`orquestra: mint candidate ${c.canonicalKey} (datanet ${datanetId}) dataset write failed, skipped — ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    intents.push({
      kind: 'mint', datanetId, subnetUuid: rubric.subnetUuid, canonicalKey: c.canonicalKey,
      podName: clampPodName(c.podName), podDescription: clampPodName(c.podDescription, POD_DESC_MAX), datasetPath,
      estReppoCost: opts.estReppoCost ?? 0, selfScore: score,
      ...(reason ? { reason } : {}),
      ...(c.sourceUrl ? { sourceUrl: c.sourceUrl } : {}),
      ...(c.imageUrl ? { imageUrl: c.imageUrl } : {}),
      ...(panel ? { panel } : {}),
    })
  }
  return intents
}
