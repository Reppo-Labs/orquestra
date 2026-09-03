// Evidence retrieval: fetch every datanet this node can read, then rank the
// union lexically against the job (eval-datanet-grounding design D2).
//
// DESIGN AMENDMENT vs eval-judge-v1 design.md decision 3: the design sketched
// node-side cosine over embeddings, but scoring a QUERY that way needs an
// embeddings endpoint on the node, and several supported LLM providers
// (notably anthropic-oauth) have none. Ranking is therefore lexical —
// tokenized tf-style overlap weighted by inverse document frequency — which
// needs no provider call at all. Lexical overlap is only a CANDIDATE filter:
// the relevance gate (gate.ts) decides what actually counts as evidence.
import type { DatanetSource } from './datanet.js'
import type { DatanetPod, EvalJobRequest } from './types.js'

/** Top-k candidates handed to the relevance gate (design D2). */
export const DEFAULT_TOP_K = 12
/** Per-datanet read cap — datanets are fetched whole, bounded (design D2). */
export const DEFAULT_PODS_PER_DATANET = 200

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9$%]+/)
    .filter((t) => t.length > 2)

export interface RankedPod {
  pod: DatanetPod
  score: number
}

/** Rank pods by lexical relevance to the query; return the top k with score > 0. */
export function topKRelevant(query: string, pods: DatanetPod[], k = 5): RankedPod[] {
  const queryTokens = new Set(tokenize(query))
  if (queryTokens.size === 0 || pods.length === 0) return []

  // Document frequency per token across the corpus — common tokens carry less signal.
  const df = new Map<string, number>()
  const podTokens = pods.map((p) => {
    const tokens = new Set(tokenize(`${p.name} ${p.text}`))
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1)
    return tokens
  })

  const n = pods.length
  const ranked: RankedPod[] = []
  for (let i = 0; i < pods.length; i++) {
    const tokens = podTokens[i]!
    let score = 0
    for (const t of queryTokens) {
      if (tokens.has(t)) score += Math.log(1 + n / (df.get(t) ?? 1))
    }
    if (score > 0) ranked.push({ pod: pods[i]!, score })
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked.slice(0, k)
}

export interface GatheredEvidence {
  /** Top-k lexical candidates across every accessible datanet. */
  candidates: RankedPod[]
  /** Every datanet id read — what a denial reports as `datanetsSearched`. */
  datanetsSearched: number[]
}

/** Read every accessible datanet (bounded) and rank the union against the
 *  request. Any source failure propagates: the worker must :fail, never deny,
 *  when it could not look. */
export async function gatherEvidence(
  source: DatanetSource,
  request: EvalJobRequest,
  k = DEFAULT_TOP_K,
  podsPerDatanet = DEFAULT_PODS_PER_DATANET,
): Promise<GatheredEvidence> {
  const datanets = await source.listAccessible()
  // Per-datanet, not all-or-nothing: one flaky datanet must not cost the job
  // the evidence the others answered with. `datanetsSearched` therefore lists
  // only the datanets actually READ — a denial may never claim to have looked
  // somewhere it could not reach. Only a total failure is an outage (→ :fail),
  // and it rethrows the FIRST reason so a typed DatanetError (401/403) keeps
  // its status for the worker's auth backoff.
  const settled = await Promise.allSettled(datanets.map((d) => source.fetchPods(d.datanetId, podsPerDatanet)))
  const pods: DatanetPod[] = []
  const datanetsSearched: number[] = []
  for (const [i, r] of settled.entries()) {
    const id = datanets[i]!.datanetId
    if (r.status === 'fulfilled') {
      pods.push(...r.value)
      datanetsSearched.push(id)
      continue
    }
    console.error(`orquestra: evalwork: datanet ${id} unreadable (${r.reason instanceof Error ? r.reason.message : String(r.reason)}) — excluded from this job's evidence`)
  }
  if (datanets.length > 0 && datanetsSearched.length === 0) {
    throw (settled[0] as PromiseRejectedResult).reason
  }
  const query = `${request.payload} ${request.criteria.join(' ')}`
  return { candidates: topKRelevant(query, pods, k), datanetsSearched }
}
