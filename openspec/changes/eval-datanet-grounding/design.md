## Context

See proposal.md. Current worker: lease → `fetchCorpus(job.corpusUrl)` → `topKRelevant` (lexical tf-idf, `retrieve.ts`) → `judgeEval` (one LLM call, citations filtered to retrieved ids, `model-judgment` when none) → `:complete`. Gateway now (eval-api `ad217dd`): no corpus, object citations, mandatory grounding, `:deny`. Node credentials: platform agent identity (`REPPO_AGENT_ID` / `REPPO_API_KEY`), already sent to the gateway; the platform base is `platformBase()` (`reppo.ai` / `robinhood.reppo.ai`). The datanet API the nodes should read is not yet documented.

## Goals / Non-Goals

**Goals:** a node never submits an ungrounded verdict; a node with no evidence says so cheaply; the datanet binding is one file; the wire contract is fixture-pinned and identical to eval-api's.

**Non-Goals:** embeddings; per-criterion denial (gateway is per-job); gateway-side relevance checking; changing vote/mint lanes.

## Decisions

### D1. `DatanetSource` port, provisional HTTP binding
```
interface DatanetSource {
  listAccessible(): Promise<{ datanetId: number; name: string }[]>
  fetchPods(datanetId: number, limit: number): Promise<DatanetPod[]>   // { datanetId, podId, name, text }
}
```
`datanet.ts` holds the interface + `InMemoryDatanetSource` + `DatanetError` (status-carrying, so 401/403 gets a named cause and a 10x backoff) + the TTL cache's `invalidate()` (called on a gateway `422 UNRESOLVABLE_CITATION`, so a pod deleted after caching is not re-cited by every job in the TTL window); `datanetClient.ts` binds it to `GET {base}/datanets` and `GET {base}/datanets/{id}/pods?limit=` with `Authorization: Bearer <REPPO_API_KEY>`, base = `EVAL_DATANET_API_URL ?? platformBase()`. Shape is an assumption mirroring eval-api's `client.ts`; both files change together when docs arrive. Failures throw (→ `:fail`), never read as "no evidence".
*Rejected:* reusing `/public/pods` (unauthenticated, single global catalog, no per-node access notion).

### D2. Retrieval = fetch-all + lexical rank, bounded
Per job: pods from every accessible datanet (cap `podsPerDatanet` = 200, cached per node for `cacheMs` = 5 min since datanets change slowly), `topKRelevant` over the union with k = 12. `RankedPod` gains `datanetId`. Lexical stays because several providers have no embeddings endpoint (existing amendment). Per-datanet reads are `allSettled`, not all-or-nothing: a single flaky datanet is logged and excluded, `datanetsSearched` names only the datanets actually read (a denial may not claim one it never reached), and only a TOTAL failure rethrows (→ `:fail`, an outage is not a denial). The rethrow preserves the first rejection, so a `DatanetError` 401/403 keeps its status for the worker's auth backoff.

### D3. Relevance gate = one structured LLM call
Input: criteria + the top-k pods (id, name, text). Output schema: `{ perCriterion: { criterion, supportingPods: string[] }[] }` where pod keys are `"datanetId/podId"`. Rules in the prompt: a pod supports a criterion only if it contains information a judge could use to score that criterion; keyword overlap is not support. Post-check: keys must be in the candidate set; criteria matched by exact text, positional fallback only when counts match (same discipline as `judgeEval`). Any criterion with an empty set → `DenyDecision { unsupported: string[] }`. Zero candidates → deny without the call.
*Rejected:* tf-idf score threshold (corpus-size dependent, gameable by keyword stuffing); asking the judge to self-report (the judge is the party we are guarding).

### D4. Judge cites from the gated set only, ≥1 per criterion
`buildEvalPrompt` lists only gated pods per criterion and says citations are mandatory. Post-check strips ungated keys, maps keys → `{ datanetId, podId }`, and throws `judge cited nothing for criterion X` if empty → worker `:fail`s (retryable, budget already spent). `evidenceBasis` removed from `JudgeOutcome`.

### D5. Worker flow and outcomes
```
lease → cutoff check → budget.reserve() → retrieve → gate
  → unsupported ≠ ∅ : client.deny(...)      → activity 'denied'
  → else            : judge → complete       → activity 'executed'
```
Budget: one reservation covers gate + judge (they are one job's spend), taken before retrieval so no lease/reserve race can burn jobs — and **released** on any path that fails before the first model call (datanet outage, no accessible datanets, the zero-candidate denial the gate short-circuits), so an outage cannot drain `maxJudgeCallsPerDay` with zero LLM spend. `:deny` errors: 4xx except 408/429 terminal; a 409 ALREADY_ANSWERED means the gateway adjudicated. `EvalActivityRow.status` gains `'denied'`; `appendActivity` kind stays `'eval'`.

### D6. Contract fixtures copied, not re-authored
`cp` the five files from eval-api `fixtures/lease-ack/` at `ad217dd`, delete `corpus-snapshot.json`, re-pin checksums in `leaseAckContract.test.ts` from eval-api's `CHECKSUMS.sha256`. Contract tests: lease parse (and old-shape rejection), complete round-trip, deny round-trip, fail round-trip.

## Risks / Trade-offs
- [Gate cost doubles LLM calls per job] → the gate runs on the SAME model as the judge (`liveDefaultModel()`; this repo has no small-model helper), bounded k = 12, and one budget reservation covers both calls — so `maxJudgeCallsPerDay` bounds JOBS, not LLM calls, and a job can cost up to two full-price calls. A denial with zero candidates costs no call at all (and gives its reservation back).
- [Gate too strict → denial rate high] → activity log + dashboard count `denied`; tune k and prompt from data.
- [Datanet API shape wrong] → isolated to `datanetClient.ts`; contract test uses the fake; first real run is the launch smoke.
- [Fleet must ship before gateway deploys] → stated in both PR bodies; eval-api task 9.3 tracks it.

## Open Questions
- Datanet API: auth header, list endpoint, pod text field, pagination — only `datanetClient.ts` depends on it.
