// src/minter/select.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CandidatePod, CandidateScorer } from '../adapter/types.js'
import { clampPodName, POD_DESC_MAX } from '../adapter/podName.js'
import type { MintRubric } from '../rubric/types.js'
import type { MintIntent } from '../wallet/intents.js'
import { redactSecrets } from '../util/redact.js'

export interface SelectMintsOpts {
  dataDir: string
  /** mint a candidate only if its LLM score is >= this (1-10). */
  minScore: number
  /** canonical keys already minted (ledger dedup). */
  seenKeys: Set<string>
  scorer: CandidateScorer
  /** optional REPPO cost estimate per mint for the budget. */
  estReppoCost?: number
  /** 'pin' (default): pin the dataset JSON to IPFS. 'url-only': register the
   *  candidate's sourceUrl as the pod, no pinning/Pinata (candidates without a
   *  sourceUrl are skipped). */
  mintMode?: 'pin' | 'url-only'
}

/** Score candidates vs the publisher spec; mint those >= minScore that aren't
 *  already seen. Writes each minted dataset body to disk and references it. */
export async function selectMints(
  datanetId: string,
  candidates: CandidatePod[],
  rubric: MintRubric,
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
      console.error(redactSecrets(`orquestra: mint candidate ${c.canonicalKey} (datanet ${datanetId}) scoring failed, skipped — ${e instanceof Error ? e.message : String(e)}`))
      continue
    }
    const { score, reason, panel } = result
    if (score < opts.minScore) continue

    // url-only: register the source URL as the pod, no dataset pinned (no Pinata).
    // A candidate with no sourceUrl can't be minted this way — skip it.
    let datasetPath: string | undefined
    if (opts.mintMode === 'url-only') {
      if (!c.sourceUrl) {
        console.error(`orquestra: mint candidate ${c.canonicalKey} (datanet ${datanetId}) skipped — url-only mint needs a sourceUrl, candidate has none`)
        continue
      }
    } else {
      // pin: write the dataset body so the CLI can pin it to IPFS. The write is
      // inside per-candidate isolation: one disk failure skips THAT candidate.
      datasetPath = join(dataOut, `mint-${c.canonicalKey}.json`)
      try {
        writeFileSync(datasetPath, JSON.stringify(c.dataset))
      } catch (e) {
        console.error(redactSecrets(`orquestra: mint candidate ${c.canonicalKey} (datanet ${datanetId}) dataset write failed, skipped — ${e instanceof Error ? e.message : String(e)}`))
        continue
      }
    }
    intents.push({
      kind: 'mint', datanetId, subnetUuid: rubric.subnetUuid, canonicalKey: c.canonicalKey,
      podName: clampPodName(c.podName), podDescription: clampPodName(c.podDescription, POD_DESC_MAX),
      estReppoCost: opts.estReppoCost ?? 0, selfScore: score,
      ...(datasetPath ? { datasetPath } : {}),
      ...(reason ? { reason } : {}),
      ...(c.sourceUrl ? { sourceUrl: c.sourceUrl } : {}),
      ...(c.imageUrl ? { imageUrl: c.imageUrl } : {}),
      ...(panel ? { panel } : {}),
    })
  }
  return intents
}
