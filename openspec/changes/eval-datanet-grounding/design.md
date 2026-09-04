## Context

See proposal.md. Current worker: lease → `fetchCorpus(job.corpusUrl)` → `topKRelevant` (lexical tf-idf, `retrieve.ts`) → `judgeEval` (one LLM call, citations filtered to retrieved ids, `model-judgment` when none) → `:complete`. Gateway now (eval-api `ad217dd`): no corpus, object citations, mandatory grounding, `:deny`. Node credentials: platform agent identity (`REPPO_AGENT_ID` / `REPPO_API_KEY`), already sent to the gateway; the platform base is `platformBase()` (`reppo.ai` / `robinhood.reppo.ai`). The datanet API the nodes read was PROBED LIVE on 2026-09-04 (it remains undocumented, but it is no longer unknown).

## Goals / Non-Goals

**Goals:** a node never submits an ungrounded verdict; a node with no evidence says so cheaply; the datanet binding is one file; the wire contract is fixture-pinned and identical to eval-api's.

**Non-Goals:** embeddings; per-criterion denial (gateway is per-job); gateway-side relevance checking; changing vote/mint lanes.

## Decisions

### D1. `DatanetSource` port, HTTP binding against the real public API
```
interface DatanetSource {
  listAccessible(): Promise<{ datanetId: string; name: string }[]>      // datanetId = subnet cuid
  fetchPods(datanetId: string, limit: number): Promise<DatanetPod[]>    // { datanetId, podId, name, text }
}
```
`datanet.ts` holds the interface + `InMemoryDatanetSource` + `DatanetError` (status-carrying, so 401/403 gets a named cause and a 10x backoff) + the TTL cache's `invalidate()` (called on a gateway `422 UNRESOLVABLE_CITATION`, so a pod deleted after caching is not re-cited by every job in the TTL window).

`datanetClient.ts` binds the port to the endpoints PROBED LIVE on 2026-09-04 against `https://reppo.ai/api/v1`, base = `EVAL_DATANET_API_URL ?? platformBase()`. **Both endpoints are public and UNAUTHENTICATED** — no credential is sent and the client has no `apiKey` option; `REPPO_API_KEY` authenticates the gateway calls only.

- `GET {base}/public/subnets` → `{ data: { subnets: [{ id, subnetName, subnetDescription, tokenId, chainId, status, … }] } }` (19 rows as probed) → `{ datanetId: id, name: subnetName }`.
- `GET {base}/public/pods?filters[subnet]=<subnetCuid>` → `{ data: { pods: [{ id, name, description, url, tokenId, privateSubnetId, chainId, podValidityEpoch, creator, … }] } }` → `{ datanetId: privateSubnetId, podId: id, name, text: description }`. A pod's text is `description` (avg ~1154 chars, never empty); there is **no `text` field**, and a pod's `tokenId` is the POD's own on-chain id, never the datanet's.
- `page` and `limit` are IGNORED by the server (`limit=3` returned 3343 rows); `filters[subnet]` is what bounds a read, so `podsPerDatanet` is applied CLIENT-side. `filters[currentEpoch]` does not filter by the value passed (142 and 143 both returned the same currently-valid pod), so it is not sent — the node wants the datanet's pods, not just this epoch's.
- A subnet cuid that names nothing answers `200 { data: { pods: [] } }`, not a 404.

Envelopes are read STRICTLY (`data.subnets`, `data.pods`) with no lenient fallback to a bare array or another key: a lenient reader is exactly what let the gateway's WRONG envelope pass eleven green unit tests, so shape drift must be a loud failure rather than a silent empty read. Every non-2xx and every drifted body throws; non-2xx throws a status-carrying `DatanetError`, so a proxy/WAF 401/403 on a public endpoint still reaches the worker's credential backoff. `datanetClient.live.test.ts` (gated on `DATANET_LIVE`, skipped in CI) is the only guard that can falsify the vendor shape — a mock confirms the assumption back to itself.

eval-api's `src/datanet/client.ts` binds the SAME API from the other side: the node needs the two LIST endpoints above, the gateway needs single-pod existence (`GET {base}/public/pods/{podCuid}` → `{ data: { pod: … } }`, 404 `{"error":"Pod not found"}`). The bases are separate env vars on separate deployments (`EVAL_DATANET_API_URL` here, `DATANET_API_URL` there) and the node's default `platformBase()` already ends in `/api/v1`, so the two values must never be copied across. Both files change together.

**A datanet is identified by its SUBNET CUID string, never a number.** The numeric `tokenId` on a subnet row was rejected for two independent reasons: (1) it collides across chains — `tokenId` "2" is one subnet on 8453 and a different one on 4663 — so it is not an identifier at all; and (2) 26 subnets have pods while only 19 appear in `/public/subnets`, so 66 pods have no numeric id to be named by. The cuid is what a pod row itself carries as `privateSubnetId`, which makes the pod→datanet attribution readable off the row rather than inferred from the request.

A total read failure throws (→ `:fail`) and a partial one is reported as `unreadable` (D2); neither ever reads as "no evidence".

*Rejected:* the numeric subnet `tokenId` as the datanet id (collides across chains; 66 pods have none) — see above. *Superseded:* the original rejection of `/public/pods` ("unauthenticated, single global catalog, no per-node access notion") — the live probe showed `filters[subnet]` bounds it per datanet, and unauthenticated is what the API actually is: there is no per-node access notion to model, so every node reads the same 19 subnets.

### D2. Retrieval = fetch-all + lexical rank, bounded
Per job: pods from every accessible datanet (cap `podsPerDatanet` = 200, cached per node for `cacheMs` = 5 min since datanets change slowly), `topKRelevant` over the union with k = 12. `RankedPod` gains `datanetId`. Lexical stays because several providers have no embeddings endpoint (existing amendment). Per-datanet reads are `allSettled`, not all-or-nothing: a single flaky datanet is logged and excluded, `datanetsSearched` names only the datanets actually read (a denial may not claim one it never reached), and only a TOTAL failure rethrows (→ `:fail`, an outage is not a denial). The rethrow preserves the first rejection, so a `DatanetError` 401/403 keeps its status for the worker's auth backoff. A partial read is reported as such: `GatheredEvidence.unreadable` names the datanets that failed, and the worker **never denies while it is non-empty** — a denial is terminal gateway-side, and the supporting pod may sit in the one datanet this node could not open, so absence of evidence is only evidence of absence after a COMPLETE read. Partial + unsupported → `:fail` (retryable by another node or a later lease); partial + supported → judge and `:complete` normally on what was read. `datanetsSearched` and `unreadable` are subnet-cuid `string[]` (D1); because a cuid is ~25 characters, the denial reason's clamp — not the caller — is what keeps a many-datanet denial inside the gateway's 2000-char cap.

### D3. Relevance gate = one structured LLM call
Input: criteria + the top-k pods (id, name, text). Output schema: `{ perCriterion: { criterion, supportingPods: string[] }[] }` where pod keys are `"datanetId/podId"` (subnet cuid / pod cuid — a cuid contains no `/`, so the join stays unambiguous). Rules in the prompt: a pod supports a criterion only if it contains information a judge could use to score that criterion; keyword overlap is not support. Post-check: keys must be in the candidate set; criteria matched by exact text, positional fallback only when counts match (same discipline as `judgeEval`). Any criterion with an empty set → `DenyDecision { unsupported: string[] }`. Zero candidates → deny without the call.
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
- ~~Datanet API: auth header, list endpoint, pod text field, pagination~~ — RESOLVED by live probe 2026-09-04 (D1): no auth, `/public/subnets` + `/public/pods?filters[subnet]=`, text is `description`, server-side paging params are ignored.
