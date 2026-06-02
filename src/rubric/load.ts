// src/rubric/load.ts
import { parseDatanetRubric } from './parse.js'
import { type DatanetRubric } from './types.js'
import { queryDatanetJson, type DatanetJsonFetcher } from '../reppo/queryDatanet.js'

const cache = new Map<string, DatanetRubric>()

export function clearRubricCache(): void {
  cache.clear()
}

export interface GetRubricDeps {
  /** Override the metadata source (default: reppo CLI). Injected in tests. */
  fetcher?: DatanetJsonFetcher
  /** Bypass + refresh the cache for this id. */
  refresh?: boolean
}

/** Load + parse a datanet's rubric, cached for the process lifetime. */
export async function getDatanetRubric(datanetId: string, deps: GetRubricDeps = {}): Promise<DatanetRubric> {
  const { fetcher = queryDatanetJson, refresh = false } = deps
  if (!refresh) {
    const hit = cache.get(datanetId)
    if (hit) return hit
  }
  const raw = await fetcher(datanetId)
  const rubric = parseDatanetRubric(raw)
  cache.set(datanetId, rubric)
  return rubric
}
