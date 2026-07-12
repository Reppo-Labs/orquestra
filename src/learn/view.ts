// src/learn/view.ts
// Read model for the dashboard Learning tab: per-datanet enabled flag + active lessons
// + calibration stats + economics, plus all pending config proposals.
import { computeStats, type LearnStats } from './stats.js'
import { computeEconStats, type EconStats } from './econStats.js'
import { readOutcomes, readLessons, readProposals, readEconEpochs, getLearnEnabled, type LessonRow, type ProposalRow } from './store.js'
import { readSnapshot } from '../dashboard/snapshot.js'

export interface LearnDatanetView {
  enabled: boolean
  lessons: LessonRow[]
  stats: LearnStats
  /** Economics reflection saw this epoch — omitted (not just empty) when the datanet has
   *  zero econ_epochs coverage, so old/no-economics responses stay byte-shaped. */
  econ?: EconStats
}
export interface LearnView {
  datanets: Record<string, LearnDatanetView>
  proposals: ProposalRow[]
}

export function buildLearnView(dataDir: string, datanetIds: string[]): LearnView {
  const latestYields = readSnapshot(dataDir)?.datanetEconomics
  const datanets: Record<string, LearnDatanetView> = {}
  for (const id of datanetIds) {
    const latestYield = latestYields?.find((d) => d.datanetId === id)
    const econ = computeEconStats(id, readEconEpochs(dataDir, id), latestYield)
    datanets[id] = {
      enabled: getLearnEnabled(dataDir, id),
      lessons: readLessons(dataDir, id, { activeOnly: true }),
      stats: computeStats(readOutcomes(dataDir, id), id),
      ...(econ.epochsCovered > 0 ? { econ } : {}),
    }
  }
  return { datanets, proposals: readProposals(dataDir, { status: 'pending' }) }
}
