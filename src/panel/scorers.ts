// src/panel/scorers.ts — decorator scorers that wrap the single-call scorers with
// the panel. They implement the existing PodScorer / CandidateScorer interfaces, so
// the wiring swaps them in without selection logic changing.
//
// Deliberation (all-or-none, no band):
//   votes — panel EVERY vote when deliberation.votePanel; else the single scorer.
//   mints — the panel always convenes while enabled (every mint costs REPPO).
import type { LanguageModel } from 'ai'
import type { PodScorer, PodScore } from '../voter/types.js'
import type { CandidateScorer, CandidatePod } from '../adapter/types.js'
import type { DatanetRubric } from '../rubric/types.js'
import { candidateScoreInput } from '../minter/score.js'
import { runPanel, type PanelGenerate } from './deliberate.js'

export interface PanelScorerOpts {
  model: LanguageModel
  /** Read the deliberation settings LIVE so a dashboard hot-reload of the
   *  `deliberation` block takes effect on the next decision. enabled=false →
   *  pass-through to the single scorer for everything; votePanel=true → ALL votes go
   *  to the panel, false → votes use the single scorer (mints always use the panel
   *  while enabled). */
  getDeliberation: () => { enabled: boolean; votePanel: boolean }
  /** Operator strategy brief for the judge, read live (dashboard notes edits hot-reload). */
  getBrief?: () => string
  /** Learned-lessons block for the judge, per datanet, read live (operator veto/disable
   *  and new reflections take effect on the next decision). */
  getLessons?: (datanetId: string) => string
  /** override the panel's generation backend (tests). */
  generate?: PanelGenerate
}

/** Vote scorer: panel every vote (when enabled + votePanel), else the single scorer. */
export function createPanelPodScorer(base: PodScorer, opts: PanelScorerOpts): PodScorer {
  return {
    async scorePod(pod, rubric, thresholds): Promise<PodScore> {
      // A VIDEO pod (mediaUrl set) MUST go to the multimodal screen scorer (`base`,
      // createLlmScorer's `pod.mediaUrl` branch). The panel personas are text-only and
      // drop the media, so routing a video pod through runPanel would silently score it
      // blind. This bypass is unconditional — independent of deliberation.votePanel —
      // because the panel can never see the video. Text pods are unaffected.
      if (pod.mediaUrl) return base.scorePod(pod, rubric, thresholds)
      const { enabled, votePanel } = opts.getDeliberation()
      if (!enabled || !votePanel) return base.scorePod(pod, rubric, thresholds)
      try {
        const r = await runPanel(opts.model, { name: pod.name, description: pod.description, rubric }, { brief: opts.getBrief?.(), lessons: opts.getLessons?.(rubric.datanetId), generate: opts.generate })
        return { score: r.score, reason: r.reason, panel: r.transcript }
      } catch (e) {
        // Panel failed entirely — fall back to the single scorer (never more fragile).
        console.error(`orquestra: panel fell back to single scorer for pod ${pod.podId} — ${e instanceof Error ? e.message : String(e)}`)
        return base.scorePod(pod, rubric, thresholds)
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
      const r = await runPanel(opts.model, { name, description, rubric }, { brief: opts.getBrief?.(), lessons: opts.getLessons?.(rubric.datanetId), generate: opts.generate })
      return { score: r.score, reason: r.reason, panel: r.transcript }
    },
  }
}
