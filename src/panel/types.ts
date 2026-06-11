// src/panel/types.ts — shared deliberation types. This module imports nothing
// from voter/adapter/wallet/dashboard, so those can all depend on it without a
// cycle (PodScore, CandidateScorer, intents, and activity entries each carry an
// optional PanelTranscript).

/** One panelist's contribution to a deliberation. */
export interface PanelistVerdict {
  /** persona id, e.g. 'bull' | 'bear' | 'purist' */
  persona: string
  /** 1-10 score the persona assigned */
  score: number
  /** the persona's short argument (≤400 chars) */
  argument: string
}

/** The full record of a panel decision, attached to the resulting intent +
 *  activity entry so the operator can inspect the debate. */
export interface PanelTranscript {
  /** cheap single-scorer score that triggered the panel; absent for mints (no screen). */
  screenScore?: number
  panelists: PanelistVerdict[]
  /** the judge's final ruling — this score is THE score the threshold applies to. */
  judge: { score: number; reason: string }
}
