// src/adapter/types.ts
import type { DatanetRubric } from '../rubric/types.js'

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
}

export interface AdapterContext {
  datanetId: string
  rubric: DatanetRubric
  /** how many top wallets / items to pull (adapter-specific budget). */
  topN: number
  /** optional per-operator strategy params (e.g. gdelt focus/angle/brief). Adapter-specific. */
  strategy?: Record<string, unknown>
  /** names of pods already on-chain for this datanet, for novelty dedup. */
  existingPodNames?: string[]
}

/** A pluggable per-datanet data source. The reference impl is `hyperliquid`. */
export interface DatanetAdapter {
  id: string
  /** does this adapter serve the given datanet? (by id mapping or domain) */
  matches(datanetId: string, rubric: DatanetRubric): boolean
  /** source + label domain data into mint candidates. */
  discover(ctx: AdapterContext): Promise<CandidatePod[]>
}

/** Scores a candidate 1-10 against the datanet's publisher spec. LLM by default. */
export interface CandidateScorer {
  scoreCandidate(candidate: CandidatePod, rubric: DatanetRubric): Promise<{ score: number; reason: string }>
}
