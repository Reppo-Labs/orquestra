# Eval work — serving Reppo Evaluation API jobs

Your node can act as a **judge** for the [Reppo Evaluation API](https://github.com/Reppo-Labs/eval-api): agents submit their output plus criteria, the gateway hands the job to judging nodes, each node scores it grounded in datanet pods, and the gateway settles the verdicts. This page is the complete operator description of that lane.

It is **off by default**, opt-in, and isolated: the eval worker runs beside the scheduler, never inside the vote/mint cycle, never touches the wallet, and spends **LLM tokens only**. In v1 there is no payment for eval work.

## What the node does, per job

```
lease ──► reserve budget ──► read datanet pods ──► gate (LLM #1) ──► judge (LLM #2) ──► :complete
                                                        │
                                                        └── nothing bears on a criterion ──► :deny
```

1. **Lease.** Long-polls `POST {EVAL_GATEWAY_URL}/v1/node/jobs:lease` (25 s wait) with the node's platform agent identity. A lease is the caller's request inline: `type` (`answer | plan | trace | artifact`), `payload`, 1–10 `criteria`, optional `context`, plus the protocol `epoch` and the `answerCutoff` after which no response is accepted.
2. **Reserve budget.** One unit of `evalWork.maxJudgeCallsPerDay` is reserved before any model call. No budget → the job is handed back with `:fail` and left for other nodes. With the cap unset, every job is accepted (usage is still counted).
3. **Read evidence.** The node lists every datanet on the public catalog (`GET {EVAL_DATANET_API_URL}/public/subnets`), fetches every pod of each (`/public/pods?filters[subnet]=<cuid>`), and ranks them lexically against the payload + criteria. Top 12 become candidates. Reads are cached 5 minutes. No credential is sent; the endpoints are public.
4. **Gate** (one LLM call). For each criterion, which candidate pods actually bear on it? Shared vocabulary is not support. Zero candidates skips the call entirely.
5. **Judge** (one LLM call). Score each supported criterion 1–10 with a critique, citing only pods the gate allowed. The model is the node's default model (`LLM_PROVIDER` / `LLM_API_KEY`), and its id is reported to the gateway.
6. **Submit.**
   - Every criterion supported → `:complete` with `{ jobId, model, verdicts[] }`, each verdict carrying `{ datanetId, podId }` citations. The gateway verifies every cited pod exists on the named datanet.
   - Any criterion unsupported → `:deny` with the reason and the datanets searched. A denial is not a fault; it tells the caller to reframe.
   - Any datanet was unreadable while a criterion went unsupported → `:fail` (absence of evidence is not evidence of absence). Model errors after retries → `:fail`.

A verdict that would leave a criterion with zero citations is never sent: the node throws and reports `:fail` instead. There is no ungrounded path.

Nodes are **quorum-oblivious**: lease, judge, submit, always. When the job settles, how many judges count, and what the caller sees is entirely the gateway's concern (see `docs/node-protocol.md` in the eval-api repo).

## Enable it

Two switches, both required.

**1. Environment** (`.env`):

```sh
EVAL_GATEWAY_URL=https://jjpt8cr7qh.execute-api.us-west-2.amazonaws.com   # base URL, no /v1
REPPO_AGENT_ID=…      # your node's platform agent identity
REPPO_API_KEY=…       # same credentials the reppo CLI uses; sent to the gateway only
```

Docker images bake `EVAL_GATEWAY_URL` to the public gateway, so under `docker compose` only the agent credentials are needed. Non-Docker runs must set the URL explicitly. Missing credentials log `evalwork disabled — EVAL_GATEWAY_URL is set but agent credentials are missing` and the lane stays off.

**2. Strategy config** (`evalWork` block, hot-reloaded — no restart):

```json
"evalWork": {
  "enabled": true,
  "maxConcurrent": 2,
  "maxJudgeCallsPerDay": 200
}
```

`maxJudgeCallsPerDay` is optional — omit it to accept every job with no daily cap.

| Key | Default | Range | Meaning |
|---|---|---|---|
| `enabled` | `false` | | Master switch. Config on but `EVAL_GATEWAY_URL` unset logs `evalwork enabled in config but EVAL_GATEWAY_URL is not set`. |
| `maxConcurrent` | `2` | 1–10 | Jobs judged in parallel. The node stops leasing while this many are in flight. |
| `maxJudgeCallsPerDay` | unset (no cap) | 1–10000 | Judged **jobs** per UTC day (each may cost two model calls). Unset means every job is accepted. Usage is persisted in `<data dir>/evalwork-budget.json` either way; a job that fails before the gate releases its reservation. |

The dashboard has no dedicated eval toggle yet; edit the block in the Strategy tab's config and Save. The startup log confirms the lane: `evalwork ready — gateway <url>, datanet api <url> (enabled=true, cap=<n>|none)`.

### Environment reference

| Variable | Default | Notes |
|---|---|---|
| `EVAL_GATEWAY_URL` | Docker: public gateway; else unset | Base URL **without** `/v1`. Unset → lane never starts. |
| `REPPO_AGENT_ID` / `REPPO_API_KEY` | — | Sent as `x-agent-id` / `x-api-key` on every gateway call. Never sent to the datanet API. |
| `EVAL_DATANET_API_URL` | `https://reppo.ai/api/v1` | Where evidence is read. Same default on **every** network, including robinhood, because it is the catalog the gateway verifies citations against — pods from `robinhood.reppo.ai` do not exist there and earn `UNRESOLVABLE_CITATION`. Public, no credential. Not the gateway's own `DATANET_API_URL`. |
| `ORQUESTRA_DATA_DIR` | `./data` | Holds `evalwork-budget.json`. |

Fixed in code: 25 s lease long-poll, 30 s request timeout, 30 s idle poll, 2 submit retries, 5-min datanet cache, top-12 candidates, 2000-char deny reason.

## Cost

- **LLM tokens only.** Up to two model calls per job (gate + judge). Each prompt carries the candidate pods' text (~1 KB each, up to 12) plus the payload (≤ 32 KB). There is no daily cap unless you set `maxJudgeCallsPerDay`; it is read live, so setting or lowering it takes effect mid-day against the day's counted usage.
- **Nothing on-chain.** No signing, no gas, no REPPO. The wallet is not involved.
- **No earnings in v1.** Eval work is free to callers and unpaid to nodes; it exists to prove the judging market. On-chain receipts are tracked upstream.

## What you see

**Activity tab** — one row per served job, `kind: eval`, `cycleId: evalwork`, with the job id in the pod column and a detail line:

| status | detail | meaning |
|---|---|---|
| `executed` | `judged N criteria, M citation(s) across datanets …` | verdict submitted |
| `denied` | the deny reason (criteria excerpts + datanets searched) | no evidence — not a fault |
| `error` | the failure | `:fail` was reported; the job stays open for other nodes |
| `skipped` | `answer cut-off already passed` / `node eval budget exhausted` | leased but not judged |

Eval rows show under "all kinds"; there is no `eval` filter option yet.

**Logs** (`docker compose logs -f`, prefix `orquestra: evalwork:`): leases, submissions, gateway rejections by code, datanet read failures.

## Failure handling

| Signal in logs | Cause | Node behaviour |
|---|---|---|
| gateway `401` / `403` | wrong `REPPO_AGENT_ID` / `REPPO_API_KEY`, or the platform rejected them | backs off 5 min, logs `check REPPO_AGENT_ID/REPPO_API_KEY` |
| `422 UNRESOLVABLE_CITATION` | a cited pod does not exist on the named datanet (stale cache, or the wrong catalog — see `EVAL_DATANET_API_URL`) | terminal for that job; cache invalidated so the next job re-reads |
| `422 CRITERIA_MISMATCH` / `UNGROUNDED_VERDICT` / `400 INVALID_DENIAL` | worker/gateway contract skew | terminal, no retry; update the node |
| `409 PAST_CUTOFF` / `ALREADY_DENIED` / `ALREADY_ANSWERED` | the job settled first, or this node already responded | normal; nothing to do |
| `503 DATANET_UNAVAILABLE` / `AUTH_UNAVAILABLE` / `429` | gateway-side transient | resubmitted up to 2 more times, then `:fail` |
| datanet `401` / `403` / `429` | a proxy or WAF in front of a public endpoint, or rate limiting | 5-min backoff before the next lease |
| `no accessible datanets` | the catalog returned nothing readable | `:fail`; check `EVAL_DATANET_API_URL` |
| `lease response shape mismatch (gateway/worker version skew?)` | the gateway changed the lease contract | update the node; the fixtures in `test/fixtures/lease-ack/` pin the shape |

Every failure is caught inside the lane; nothing here can abort a vote or mint cycle. On shutdown in-flight jobs get up to 10 s to finish and a job leased mid-shutdown is handed back with `:fail("node shutting down")`.

## Safety

- The wallet signs nothing for eval work. The lane cannot spend REPPO or ETH.
- Payloads are **untrusted input** from arbitrary callers. Both prompts frame them as such and carry an injection guard; the model can only score and cite, never act.
- Credentials: `REPPO_API_KEY` goes to the gateway only. The datanet reads are anonymous.
- A job's payload and criteria are never written to a datanet, the chain, or telemetry. Activity rows store the job id and a summary line, not the payload.

## Contract with the gateway

The wire shapes (`lease-response`, `complete-request`, `deny-request`, `fail-request`, `error-codes`) live in `test/fixtures/lease-ack/` and are byte-identical to `fixtures/lease-ack/` in the eval-api repo; `test/integration/leaseAckContract.test.ts` pins their checksums. Change them on both sides or not at all. The node-side requirements are `openspec/specs/evalworker-gateway-contract/` and `openspec/specs/evalworker-evidence/`.

Source: `src/evalworker/` — `worker.ts` (loop), `client.ts` (gateway HTTP), `datanetClient.ts` + `retrieve.ts` (evidence), `gate.ts` + `judge.ts` (the two LLM calls), `budget.ts` (daily cap).
