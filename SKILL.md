---
name: orquestra-node-operator
description: >
  Operate a Reppo Orquestra node: install and run it with Docker, complete onboarding,
  author and tune the voting/minting strategy, monitor earnings and health through the
  dashboard API, and troubleshoot common failures. Use when asked to set up, run,
  configure, diagnose, or optimize an Orquestra node.
---

# Operating an Orquestra node

Orquestra is Reppo's self-hosted agentic swarm node. It runs a cycle on a configured
cadence; each cycle it **votes** (curates other operators' data pods) and **mints**
(publishes pods where it has a data adapter), bounded by operator-set budgets, signing
with the operator's wallet. It earns $REPPO through voting and minting only.

You (the agent) operate it on the human's behalf. Ground rules before anything else:

- **Never print, log, or echo `.env` contents.** It holds the wallet private key.
- **Budget caps are the security boundary.** Never suggest raising them casually; the
  ledger refuses over-budget actions *before* signing — that is load-bearing.
- The dashboard is **unauthenticated and localhost-bound by design**. Never expose port
  7070 publicly, never suggest `DASHBOARD_HOST=0.0.0.0` outside the provided
  docker-compose mapping (see `docs/adr/0002-*`).
- Real funds are involved. Confirm with the human before: enabling a new datanet
  (pays an access fee), enabling minting (pays a per-mint publishing fee), or raising
  `mintReppoMax` / `lockReppo`.

## Setup (Docker, the normal path)

```sh
cp .env.example .env        # human fills: REPPO_PRIVATE_KEY, LLM_PROVIDER, LLM_API_KEY
docker compose up -d        # pulls the image, binds dashboard to 127.0.0.1:7070
```

Build from source instead: `docker build -t orquestra:latest .` and point
`docker-compose.yml`'s `image:` at it. Full walkthrough: `README.md` → "Run a node";
deep dive: `docs/operator-guide.md`.

Minimum env: `REPPO_PRIVATE_KEY` (dedicated wallet, funded with ETH-on-Base + REPPO),
`LLM_PROVIDER`, `LLM_API_KEY`. Recommended: `RPC_URL` (private Base RPC — the public one
rate-limits; also enables exact fee accounting). Optional: `PINATA_JWT` (only to mint in
`pin` mode), `REPPO_AGENT_NAME` (display name; also changeable in the dashboard).

Every var is documented inline in `.env.example` — read it before inventing flags.

## First run: onboarding

A fresh node has no strategy and waits. Open `http://localhost:7070` (over an SSH tunnel
if remote: `ssh -L 7070:localhost:7070 <host>`) and complete the conversational
onboarding — it interviews the human about datanets, budgets, cadence, and writes
`strategy.config.json` to the data dir. **The interview finishes with a "Start the node"
button — the node does not run until it is pressed.** Headless fallback:
`docker run -it --rm --env-file .env -v "$PWD/orquestra-data:/data" orquestra:latest configure`.

After starting: the node is autonomous. First cycle begins within minutes; results land
in the dashboard's Activity tab. There is nothing to babysit.

## Monitoring (JSON API on :7070)

| Endpoint | What you get |
|---|---|
| `GET /api/health` | Liveness + 7-day activity health summary |
| `GET /api/pnl` | `{ pnl, snapshot }` — net REPPO, lifetime claimed/spent, balances, and `snapshot.llm` (per-cycle LLM cost estimate) |
| `GET /api/activity` | Last 500 actions: votes (score + reason), mints, claims, skips (with the reason a datanet was idle) |
| `GET /api/earn` | Earn verdict: minted pods, upvotes, claimable/claimed REPPO |
| `GET /api/config` | Current strategy (whitelisted fields; never secrets) |
| `GET /api/agent` | Platform agent identity `{agentId, name, renameable}` |

Diagnosis flow when the human says "is it working?": `curl -s localhost:7070/api/health`,
then `/api/earn`, then scan `/api/activity` for `status: "error"` or repeated skips with
the same reason. `docker logs orquestra --since 2h` for the raw log; every failure line
is prefixed `orquestra:` and states the datanet it affected — per-datanet failures are
isolated by design and self-heal next cycle.

## Changing strategy

Read `docs/strategy-guide.md` before editing — it explains the two layers (enforced
budget knobs vs the free-text `notes` brief injected into every scoring prompt) and what
belongs in each. Key facts:

- Edits apply at the **next cycle** (hot-reload; invalid config falls back to last-good).
- Prefer the dashboard: Strategy tab (knobs) or Assistant chat (natural-language →
  proposed config → human reviews the diff and saves).
- Programmatic edit: `POST /api/strategy` with the full candidate config (same schema as
  `GET /api/config`; validated server-side, 400 on schema violations).
- `strictness` maps the 1-10 LLM score to up/down/skip: conservative 8/4 · balanced 7/3 ·
  aggressive 6/2. `voteShare` splits the per-cycle vote cap across datanets by ratio.
- Before enabling minting on a datanet, check its fees:
  `docker exec orquestra reppo query datanet <id> --json` → `accessFeeREPPO` (one-time) and
  `publishingFeeREPPO` (per mint). Wallet must cover access + N mints.

## Troubleshooting quick table

| Symptom | Likely cause → action |
|---|---|
| `no strategy config yet` in logs | Onboarding not completed — open the dashboard |
| `LLM_PROVIDER=anthropic-oauth but no subscription is linked` | Missing/invalid `anthropic-oauth.json` in the data dir. Validate JSON parses (smart quotes from rich-text editors are the classic cause) — see README "Docker only" OAuth section |
| `datanet N skipped — DATANET_NOT_FOUND` | Datanet no longer exists — remove it from the config |
| `datanet N skipped — … transient RPC` / `INTERNAL_ERROR` | Public RPC rate-limited — set `RPC_URL` to a private endpoint |
| Every mint `refused-budget` | `mintReppoMax` below the per-mint reserve — raise it (confirm with human) or disable mint |
| Mint reverts `TransferAmountExceedsBalance` | Wallet REPPO < publishing fee — fund the wallet; check fee via `reppo query datanet` |
| `veREPPO read failed — skipping stake` | RPC blip — self-heals next cycle |
| Dashboard empty right after start | Normal — first cycle hasn't completed. `docker logs -f orquestra` |
| Onboarding lost after `docker compose down && up` | Data dir wasn't on the mounted volume — verify `ORQUESTRA_DATA_DIR=/data` and the volume mapping |

## Updating

```sh
docker compose pull && docker compose up -d   # published image
# or from source: git pull && docker build -t orquestra:latest . && recreate the container
```

State (strategy, ledgers, activity DB) lives in the mounted data volume and survives
updates. The budget ledger is the source of spend truth — if the node ever refuses to
start with `LedgerCorruptError`, do NOT delete the ledger to "fix" it without the human
explicitly accepting that spend tracking resets.

## Repo map (when you need to read code)

`CLAUDE.md` at the repo root is the code orientation (architecture, invariants,
commands). `CONTEXT.md` defines the controlled vocabulary (node vs agent, strategy vs
config). `docs/adr/` records the decisions you should not casually reverse.
