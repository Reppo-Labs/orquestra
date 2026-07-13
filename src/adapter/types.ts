// src/adapter/types.ts
import type { DatanetRubric, MintRubric } from '../rubric/types.js'
import type { PanelTranscript } from '../panel/types.js'

/** A mint candidate an adapter produced for a datanet. */
export interface CandidatePod {
  /** stable dedup key (e.g. sha256-derived). */
  canonicalKey: string
  podName: string
  podDescription: string
  /** labeled dataset body the CLI pins + mints. */
  dataset: unknown
  /** adapter's own 1-10 quality estimate, if any. */
  selfScore?: number
  /** human-viewable source page for the pod's primary link (e.g. the article). */
  sourceUrl?: string
  /** image URL for the pod card (e.g. the article's og:image). */
  imageUrl?: string
}

export interface AdapterContext {
  datanetId: string
  rubric: DatanetRubric
  /** how many top wallets / items to pull (adapter-specific budget). */
  topN: number
  /** RAW per-operator strategy params (config adapterParams + the live brief). Deliberately
   *  untyped at this boundary: each adapter parses/validates its own params with safe
   *  defaults (e.g. parseGdeltParams, parseSportsParams) — wrong-typed operator config
   *  degrades to defaults inside the adapter instead of throwing out of discover. */
  strategy?: Record<string, unknown>
  /** names of pods already on-chain for this datanet, for novelty dedup. */
  existingPodNames?: string[]
}

/** A pluggable per-datanet data source. The reference impl is `hyperliquid`.
 *  Routing is by `id` from the strategy config (see wiring.ts getAdapter). */
export interface DatanetAdapter {
  id: string
  /** source + label domain data into mint candidates. */
  discover(ctx: AdapterContext): Promise<CandidatePod[]>
}

/** Scores a candidate 1-10 against the datanet's publisher spec. LLM by default.
 *  `panel` is present when a multi-agent panel produced the score (see src/panel).
 *  Takes a MintRubric — structurally incapable of carrying the vote-only yield, so a
 *  mint prompt can never render datanet economics (rubric/types.ts). */
export interface CandidateScorer {
  scoreCandidate(candidate: CandidatePod, rubric: MintRubric): Promise<{ score: number; reason: string; panel?: PanelTranscript }>
}
