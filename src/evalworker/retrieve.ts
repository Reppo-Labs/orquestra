// Top-k evidence retrieval over the corpus snapshot.
//
// DESIGN AMENDMENT vs eval-judge-v1 design.md decision 3: the design sketched
// node-side cosine over gateway-computed embeddings, but scoring a QUERY that
// way needs an embeddings endpoint on the node, and several supported LLM
// providers (notably anthropic-oauth) have none. v1 therefore ranks lexically —
// tokenized tf-style overlap weighted by inverse document frequency — which
// needs no provider call at all. The corpus snapshot already carries pod text,
// so swapping in embeddings later is a drop-in change on this one function.
import type { CorpusPod } from './types.js'

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9$%]+/)
    .filter((t) => t.length > 2)

export interface RankedPod {
  pod: CorpusPod
  score: number
}

/** Rank pods by lexical relevance to the query; return the top k with score > 0. */
export function topKRelevant(query: string, pods: CorpusPod[], k = 5): RankedPod[] {
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
