## Why

eval-api PR #15 (merged, `ad217dd`) removed the pod mint and the gateway-frozen corpus: the gateway no longer leases a corpus URL, rejects any verdict without citations (`422 UNGROUNDED_VERDICT`), rejects the retired `evidenceBasis` field, requires citations as `{ datanetId, podId }`, and added `POST /v1/node/jobs/{id}:deny`. Every current evalworker `:complete` fails on schema against that gateway. The node must now ground each verdict in pods it retrieves itself from the datanets its credentials can read, and deny the job when nothing supports a judgment instead of emitting `model-judgment`.

## What Changes

- **BREAKING** Lease/complete wire contract: `LeasedJob` loses `datanetId` / `corpusUrl` / `corpusVersion`; `CriterionVerdict.citations` becomes `{ datanetId, podId }[]` (non-empty); `EvalAnswer.evidenceBasis` removed; `fetchCorpus` removed; new `GatewayClient.deny(jobId, reason, datanetsSearched)`. Vendored `test/fixtures/lease-ack/` re-synced with eval-api and checksums re-pinned.
- Evidence moves node-side: a `DatanetSource` port lists the datanets this node can read and fetches their pods; retrieval ranks across all of them. The HTTP binding reads the real public datanet API (`/public/subnets`, `/public/pods?filters[subnet]=`), probed live 2026-09-04; datanets are identified by subnet cuid and the endpoints take no credential.
- A **relevance gate** before judging: one bounded LLM call decides, per criterion, which retrieved pods actually bear on it. If any criterion has no supporting pod, the node **denies** the job (reason + datanets searched). Lexical overlap alone is no longer grounds to judge.
- The judge must cite at least one gated pod per criterion; a verdict that comes back uncited is a judge error (`:fail`, retryable), never an ungrounded submission.
- Worker outcomes become `executed | denied | error | skipped`; denials are recorded in the activity log and counted against the judge-call budget (the gate is an LLM call).
- `docs` / onboarding text that describes `model-judgment` or the corpus snapshot is updated.

## Capabilities

### New Capabilities
- `evalworker-evidence`: node-side evidence retrieval across accessible datanets, the relevance gate, and the deny-instead-of-fabricate rule.
- `evalworker-gateway-contract`: the lease / complete / deny / fail wire contract the worker speaks, pinned by the vendored fixtures.

### Modified Capabilities
<!-- none: openspec/specs is empty in this repo; eval-judge-v1's specs live only under its change dir -->

## Impact

- `src/evalworker/{types,client,worker,judge,retrieve}.ts` and tests; new `src/evalworker/datanet.ts` (port + fake) and `datanetClient.ts` (HTTP binding to the public datanet API, with a `DATANET_LIVE`-gated live test); new `gate.ts`.
- `src/index.ts` evalwork wiring (datanet source bound with the node's platform credentials; `EVAL_DATANET_API_URL` optional override).
- `test/fixtures/lease-ack/` + `test/integration/leaseAckContract.test.ts` (checksums, deny fixture, no corpus fixture).
- Deployment: nodes must ship BEFORE the gateway is deployed (eval-api PR #15 body). Closes eval-api openspec task 9.3.
