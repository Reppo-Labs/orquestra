// src/learn/view.ts
// Read model for the dashboard Learning tab: per-datanet enabled flag + active lessons
// + calibration stats, plus all pending config proposals.
import { computeStats, type LearnStats } from './stats.js'
import { readOutcomes, readLessons, readProposals, getLearnEnabled, type LessonRow, type ProposalRow } from './store.js'

export interface LearnDatanetView {
  enabled: boolean
  lessons: LessonRow[]
  stats: LearnStats
}
export interface LearnView {
  datanets: Record<string, LearnDatanetView>
  proposals: ProposalRow[]
}

export function buildLearnView(dataDir: string, datanetIds: string[]): LearnView {
  const datanets: Record<string, LearnDatanetView> = {}
  for (const id of datanetIds) {
    datanets[id] = {
      enabled: getLearnEnabled(dataDir, id),
      lessons: readLessons(dataDir, id, { activeOnly: true }),
      stats: computeStats(readOutcomes(dataDir, id), id),
    }
  }
  return { datanets, proposals: readProposals(dataDir, { status: 'pending' }) }
}
