// src/panel/scorers.ts — decorator scorers that wrap the single-call scorers with
// the panel. They implement the existing PodScorer / CandidateScorer interfaces, so
// the wiring swaps them in without selection logic changing.
//
// Tiering (per the spec):
//   votes — cheap screen via the base scorer first; convene the panel ONLY when the
//           screen score lands within ±voteBand of the like OR dislike threshold.
//   mints — no screen; the panel always convenes (every mint costs REPPO).
import type { LanguageModel } from 'ai'
import type { PodScorer, PodScore, ScoreThresholds } from '../voter/types.js'
import type { CandidateScorer, CandidatePod } from '../adapter/types.js'
import type { DatanetRubric } from '../rubric/types.js'
import { candidateScoreInput } from '../minter/score.js'
import { runPanel, type PanelGenerate } from './deliberate.js'

export interface PanelScorerOpts {
  model: LanguageModel
  /** Read the deliberation settings LIVE so a dashboard hot-reload of the
   *  `deliberation` block takes effect on the next decision. enabled=false →
   *  pass-through to the wrapped single scorer (today's behavior); voteBand is the
   *  ± band around like/dislike that convenes a vote panel (0 = mints only). */
  getDeliberation: () => { enabled: boolean; voteBand: number }
  /** Operator strategy brief for the judge, read live (dashboard notes edits hot-reload). */
  getBrief?: () => string
  /** override the panel's generation backend (tests). */
  generate?: PanelGenerate
}

/** A screen score is "ambiguous" when it sits within ±band of either threshold. */
export function withinBand(score: number, t: ScoreThresholds, band: number): boolean {
  return Math.abs(score - t.like) <= band || Math.abs(score - t.dislike) <= band
}

/** Vote scorer: screen, then panel only for ambiguous scores. */
export function createPanelPodScorer(base: PodScorer, opts: PanelScorerOpts): PodScorer {
  return {
    async scorePod(pod, rubric, thresholds): Promise<PodScore> {
      const { enabled, voteBand } = opts.getDeliberation()
      if (!enabled) return base.scorePod(pod, rubric, thresholds)
      const screen = await base.scorePod(pod, rubric, thresholds)
      // voteBand <= 0 means "mints only" — votes never convene a panel. Otherwise:
      // no thresholds (defensive — the vote path always passes them), or a score
      // decisively outside the band → the cheap screen result stands.
      if (voteBand <= 0 || !thresholds || !withinBand(screen.score, thresholds, voteBand)) return screen
      try {
        const r = await runPanel(opts.model, { name: pod.name, description: pod.description, rubric }, { brief: opts.getBrief?.(), screenScore: screen.score, generate: opts.generate })
        return { score: r.score, reason: r.reason, panel: r.transcript }
      } catch (e) {
        // Panel failed entirely — fall back to the screen result (never more fragile
        // than the single-scorer path).
        console.error(`orquestra: panel fell back to screen score for pod ${pod.podId} — ${e instanceof Error ? e.message : String(e)}`)
        return screen
      }
    },
  }
}

/** Mint scorer: always panel, no screen (a panel failure throws → selectMints skips
 *  that candidate, same as a single-scorer failure). */
export function createPanelCandidateScorer(base: CandidateScorer, opts: PanelScorerOpts): CandidateScorer {
  return {
    async scoreCandidate(candidate: CandidatePod, rubric: DatanetRubric) {
      if (!opts.getDeliberation().enabled) return base.scoreCandidate(candidate, rubric)
      const { name, description } = candidateScoreInput(candidate)
      const r = await runPanel(opts.model, { name, description, rubric }, { brief: opts.getBrief?.(), generate: opts.generate })
      return { score: r.score, reason: r.reason, panel: r.transcript }
    },
  }
}
