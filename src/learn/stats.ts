// src/learn/stats.ts
// The deterministic half of the hybrid reflection. Pure: turns matured outcomes into
// CALIBRATION statistics (not "follow the crowd" targets). These numbers are the ONLY
// thing fed to the reflection LLM — no raw pod/panel text — so a poisoned pod can't
// launder an instruction into a persistent lesson.
import type { OutcomeRow } from './store.js'

export interface LearnStats {
  datanetId: string
  maturedTotal: number
  // crowd-alignment of our votes (a calibration signal, not the optimization target)
  voteTotal: number
  voteAlignmentPct: number
  upVoteTotal: number
  upVoteAlignedPct: number
  downVoteTotal: number
  downVoteAlignedPct: number
  // our minted pods that ended net-upvoted
  mintTotal: number
  mintAlignmentPct: number
  // conviction calibration: do high-conviction calls hold up better than low-conviction?
  highConvictionTotal: number
  highConvictionAlignedPct: number
  lowConvictionTotal: number
  lowConvictionAlignedPct: number
  /** High-conviction calls that the crowd strongly contradicted — surfaced for review,
   *  NOT used to push scores toward consensus. */
  highConvictionReversals: number
  sampleEpochs: number
}

const pct = (aligned: number, total: number): number => (total > 0 ? Math.round((aligned / total) * 100) : 0)

const HIGH_CONVICTION = 7
const LOW_CONVICTION = 4

/** Pure: aggregate the MATURED outcomes for a datanet into calibration stats. */
export function computeStats(outcomes: OutcomeRow[], datanetId: string): LearnStats {
  const matured = outcomes.filter((o) => o.matured === 1)
  const votes = matured.filter((o) => o.kind === 'vote')
  const mints = matured.filter((o) => o.kind === 'mint')
  const up = votes.filter((o) => o.direction === 'up')
  const down = votes.filter((o) => o.direction === 'down')
  const high = matured.filter((o) => o.conviction !== undefined && o.conviction >= HIGH_CONVICTION)
  const low = matured.filter((o) => o.conviction !== undefined && o.conviction <= LOW_CONVICTION)
  const al = (rows: OutcomeRow[]) => rows.filter((o) => o.aligned === 1).length

  return {
    datanetId,
    maturedTotal: matured.length,
    voteTotal: votes.length,
    voteAlignmentPct: pct(al(votes), votes.length),
    upVoteTotal: up.length,
    upVoteAlignedPct: pct(al(up), up.length),
    downVoteTotal: down.length,
    downVoteAlignedPct: pct(al(down), down.length),
    mintTotal: mints.length,
    mintAlignmentPct: pct(al(mints), mints.length),
    highConvictionTotal: high.length,
    highConvictionAlignedPct: pct(al(high), high.length),
    lowConvictionTotal: low.length,
    lowConvictionAlignedPct: pct(al(low), low.length),
    highConvictionReversals: high.filter((o) => o.aligned === 0).length,
    sampleEpochs: new Set(matured.map((o) => o.observedEpoch)).size,
  }
}
