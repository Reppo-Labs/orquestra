// src/learn/inject.ts
// Inject step: render a datanet's active lessons into a bounded, clearly-labeled block
// for the judge prompt. Returns '' when learning is disabled for the datanet (operator
// veto) or there are no active lessons — so the prompt is byte-identical to today on a
// cold start. The block is node-authored (trusted), distinct from the untrusted pod text.
import { readLessons, getLearnEnabled } from './store.js'

/** Hard cap on injected lessons (prompt-bloat guard; reflection already caps at 5). */
const MAX_LESSONS = 5

export function buildLessonsBlock(dataDir: string, datanetId: string): string {
  if (!getLearnEnabled(dataDir, datanetId)) return ''
  const lessons = readLessons(dataDir, datanetId, { activeOnly: true }).slice(0, MAX_LESSONS)
  if (lessons.length === 0) return ''
  const body = lessons.map((l, i) => `${i + 1}. ${l.text}`).join('\n')
  return `\n## Learned lessons (trusted — distilled from THIS node's own past outcomes)\n${body}\n`
}
