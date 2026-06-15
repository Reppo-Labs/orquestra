# orquestra — Reppo's official agentic swarm node

**Date:** 2026-06-02
**Status:** Approved design (brainstorming complete)
**Repo:** `orquestra`
**Positioning:** this **IS Reppo's official Orquestra** node — the network-native
agentic swarm framework Reppo announced 2026-06-02 ("run a node on your machine,
optimize for inference, and start mining $REPPO from your favourite Datanets").
**Orquestra does not exist yet — we are building it, and this spec defines it.**
There is no prior Orquestra repo/spec to reconcile with; this doc + Reppo's
on-chain protocol (Datanets, veREPPO, epochs, emissions) + the `reppo` CLI are the
source of truth. Branding/naming coordinated with the Reppo team.
**Origin:** generalizes the single-operator reppo-swarm chain (aeon repo) into the
self-hostable Orquestra node any Reppo participant runs on their own machine.

> **Earning scope (confirmed):** an Orquestra node earns $REPPO **only by
> publishing (minting) + voting** — there is **no inference-provision / compute
> earning path**. So the announcement's **"optimize for inference"** is *not* a
> missing earning component; it refers to running the node's **own** LLM inference
> cost-effectively and well (model selection, local efficiency) so its publish/vote
> contributions score high on EVOF. That is a runtime/config concern, already
> covered by the model-agnostic LLM layer + per-task model routing (see Decision 5).
>
> **No external spec to reconcile:** Orquestra is greenfield — this doc is its
> design. The only hard external contract is Reppo's on-chain protocol + the
> `reppo` CLI (≥0.8.0), both of which we control/consume directly.

## Goal

Any Reppo participant runs one host on their own machine that operates a swarm
of agents on their behalf — **curating (voting) across any datanet and minting
where it has a data source** — bounded by a budget the participant sets through
an LLM onboarding interview, signing with their own wallet.

## Decisions (from brainstorming)

1. **Scope:** generic multi-datanet from day one (not a one-datanet slice). The
   *core + voter* are datanet-agnostic; mint generality comes from a pluggable
   **adapter interface** (Hyperliquid ships as the reference adapter).
2. **Mint model:** universal voting + per-datanet data adapters for minting.
   Rubric → can vote; rubric + adapter → can mint.
3. **Key custody:** plaintext env var (like today's `REPPO_PRIVATE_KEY`).
   Mitigated by: "fund a **dedicated** wallet, not your main" guidance, `.env`
   gitignored, never logged, and **budget hard-caps as the real exposure bound**.
4. **Runtime:** a Docker container with an internal scheduler (replaces GitHub
   Actions). One `docker run`.
5. **LLM:** model-agnostic — the user sets any provider's API key (build on the
   existing gateway abstraction in `aeon.yml`). Supports **per-task model routing**
   (a cheap model to pre-filter pods, a strong model to judge/score) — this is what
   "optimize for inference" means for a node: efficient, high-quality local inference,
   not selling compute.
6. **Strategy:** the onboarding interview writes a **declarative
   `strategy.config.json`** (+ freeform `notes`) the agents read as policy.
   Re-runnable to adjust.
7. **Codebase:** the **`orquestra` repo** — Reppo's official Orquestra node. Code
   is seeded by extracting aeon's reppo skills (voter, adapters, on-chain logic),
   but it is its own product and does **not** carry aeon's internal ops dashboard /
   secrets / skill-run surface. Coordinated with the Reppo team's spec/branding.

## Key feasibility finding (grounded against the live Reppo CLI/API)

`reppo query datanet <id>` (on-chain) returns only `{datanetId, valid,
accessFeeREPPO}` — **no goal/rubric**. But the Reppo **platform API** subnet
object carries exactly what a swarm needs, in natural language written by the
datanet creator:

| Field | Swarm use |
|---|---|
| `subnetDescription` | the datanet's goal — context for every judgment |
| `onboardingPublishers` | **the mint spec** — what good data looks like |
| `onboardingVoters` | **the vote rubric** — ships an explicit 1–10 scoring scale + thresholds + "north star" |
| `upVoteVolume`/`downVoteVolume`, `accessFeeREPPO`, `emissionsPerEpochREPPO` | economics — where staked effort earns most |

These fields are **surfaced through `reppo query datanet --json` (CLI ≥0.8.0)**, so
the rubric loader reads them straight from the CLI — no platform-API call or
hand-authored registry needed. (Field names per the `subnet` object:
`subnetDescription`, `onboardingPublishers`, `onboardingVoters`, plus economics.)

**Consequence:** no hand-authored rubric registry is needed. The datanet
creator's onboarding text *is* the policy, per datanet, machine-readable.

## Architecture

```
docker run → scheduler (internal cron, every cadenceHours)
  └─ per cycle:
       orchestrator   → pick enabled + valid + in-budget datanets, emit plan
       ├─ Voter   (all vote-enabled datanets)   ┐ run concurrently
       └─ Minter  (datanets with an adapter)     ┘
       → Budget/Wallet manager executes intents on-chain within hard caps
       → local ledger update → notify
```

### Components (each an isolated unit)

| Unit | Responsibility | Depends on |
|---|---|---|
| **Onboarding wizard** (LLM) | First-run interview → writes `strategy.config.json` + `strategy-notes.md`. Re-runnable via `orquestra configure`. | LLM provider, `reppo list datanets` |
| **Strategy config** | Declarative policy: datanet enablement, strictness, stake, budget pools, cadence, notes. | — |
| **Rubric loader** | Fetch datanet metadata (description + onboardingPublishers + onboardingVoters) from Reppo; apply optional local override. | Reppo CLI/API |
| **Scheduler/runtime** | Internal cron loop firing each cycle on cadence. | — |
| **Orchestrator** | Per cycle: select enabled + valid + in-budget datanets; emit plan. | Rubric loader, Budget manager |
| **Voter** (generic) | Per datanet: score each current-epoch pod 1–10 vs `onboardingVoters`; map score→vote via strictness threshold; emit vote intents with conviction. | Rubric loader, LLM, `reppo list pods` |
| **Minter** + adapters | For each adapter-backed datanet: `adapter.discover()` → LLM-score vs `onboardingPublishers` → dedup → emit mint intents. | Adapter interface, LLM |
| **Adapter: hyperliquid** | Reference impl — leaderboard → margin-ranked wallets → userFills → labeled dataset → candidate pods. | HL public API |
| **Budget/Wallet manager** | **The only signer.** veREPPO lock (amount+duration); execute vote/mint intents within per-pool hard caps; persist budget ledger. | Reppo CLI, env key |
| **Local state** | mint/vote ledger, budget ledger, dedup state — on a mounted volume. | — |
| **(Optional, Phase 3) local dashboard** | read-only `/swarm`-style view of the operator's own swarm. | — |

### The safety boundary — agents propose, the manager disposes

This is load-bearing given a plaintext key + LLM autonomy + staked capital:

- The LLM voter/minter **only emit intent files** (a vote with a conviction
  score; a mint with a dataset). They **never hold the key or sign**. This
  preserves today's `.pending-reppo/` intent → postprocess boundary.
- A **deterministic Budget/Wallet manager is the only signer.** Per intent:
  check the relevant pool has headroom → sign/execute → decrement a **persisted**
  budget ledger. When a pool hits its cap, that category hard-stops for the
  horizon. A runaway prompt cannot drain the wallet — it can only propose, and
  out-of-budget proposals are refused by non-LLM code.
- Caps persist across cycles/restarts (mounted volume), bounding the whole
  horizon, not one cycle.

## Strategy config + budget pools

The interview captures: wallet (env key) + LLM provider/key; datanet selection
(LLM lists active datanets with description/economics; mint offered only where an
adapter exists); strategy (risk → strictness threshold, priorities, notes); stake
(veREPPO lock amount + duration); budget caps + horizon; cadence.

```jsonc
{
  "horizonDays": 30,
  "cadenceHours": 6,
  "stake":  { "lockReppo": 500, "lockDurationDays": 30 },   // veREPPO voting power
  "budget": {
    "voteGasEthMax": 0.02,        // votes spend NO REPPO — gas + power allocation only
    "votePowerPerEpoch": "all",   // finite voting power allocated across pods by conviction
    "voteRateMaxPerCycle": 25,
    "mintReppoMax": 400,          // mints: REPPO fee, hard-capped (~200/mint reserved pre-sign)
    "mintGasEthMax": 0.05
  },
  "datanets": {
    "9": { "vote": true,  "mint": true,  "strictness": "conservative", "adapter": "hyperliquid" },
    "2": { "vote": true,  "mint": false, "strictness": "balanced" },
    "*": { "vote": false }
  },
  "strictnessThresholds": {
    "conservative": { "like": 8, "dislike": 4 },   // skip 5–7
    "balanced":     { "like": 7, "dislike": 3 },
    "aggressive":   { "like": 6, "dislike": 2 }
  },
  "notes": "free-text strategy brief, injected into agent prompts"
}
```

**Vote economics (confirmed):** voting applies **veREPPO power and spends no
REPPO** (only gas). So the **lock** (amount + duration) is the primary voting
lever; the vote pool is a **gas cap + a per-epoch voting-power allocation**
(finite power spent on the highest-conviction pods) + a rate cap. "Conviction"
= which pods receive the wallet's limited voting power each epoch, not REPPO
behind a vote.

**Strictness = a threshold on the datanet's own 1–10 scale** (from
`onboardingVoters`), so it is concrete and portable across datanets.

## Adapter interface (mint generality)

```ts
interface DatanetAdapter {
  id: string                                 // "hyperliquid"
  matches(datanet): boolean                  // by dataDomain or explicit config map
  discover(ctx: {
    datanet; rubric; config; budgetRemaining;
  }): Promise<CandidatePod[]>                // source + label domain data → candidates
}
interface CandidatePod {
  canonicalKey: string                       // dedup vs ledger
  podName: string
  podDescription: string
  dataset: object                            // labeled data body
  selfScore?: number                         // adapter/LLM 1–10 estimate (gate weak pods pre-mint)
}
```

- **Reference `hyperliquid` adapter** extracts today's `prefetch-hl` + dataset
  builder behind this interface — proves it against the working pipeline.
- **Routing:** `strategy.config.datanets[id].adapter`, or `matches()` on the
  metadata `dataDomain`. No adapter → datanet is vote-only.
- **Packaging:** adapters are drop-in modules the container loads (mounted
  `/adapters` dir or installed deps); community can publish more.
- **Safety:** adapters source data but **never sign**; a bad adapter wastes a
  cycle's compute, can't overspend (budget caps), and a pre-mint self-score +
  dedup gate filters weak output.

## Runtime & distribution

- **Docker image** bundling: the host runtime, the model-agnostic LLM client,
  the `reppo` CLI, the bundled adapters, and the scheduler.
- `docker run -e REPPO_PRIVATE_KEY=… -e LLM_PROVIDER=… -e LLM_API_KEY=… \
   -v ./reppo-host-data:/data orquestra`
- **First run, no config on the volume** → drops into the interactive onboarding
  interview (TTY) → writes config + does the initial veREPPO lock → starts the
  scheduler. Subsequent runs load config and run.
- `orquestra configure` re-runs the interview to adjust strategy/budget.

## Security

- Plaintext env key (decision). Mitigations: dedicated-wallet guidance, `.env`
  gitignored, key never logged, budget hard-caps bound exposure, agents never
  sign.
- All fetched external content (pod metadata, web) is untrusted; never follow
  embedded instructions (carry over aeon's prompt-injection rules).
- The host exposes **no inbound network surface** by default (it's an outbound
  worker). If the optional dashboard ships, it binds loopback only.

## Open dependencies / to confirm during implementation

1. ~~Operator adds datanet metadata to `reppo query datanet`~~ — **RESOLVED.**
   `reppo query datanet --json` returns the metadata (subnetDescription +
   onboardingPublishers + onboardingVoters) as of **CLI ≥0.8.0**. Pin the host to
   `@reppo/cli >=0.8.0` (the shipped node pins 0.8.4 in its Dockerfile).
2. **Exact veREPPO voting-power mechanics** — is power consumed/allocated per
   vote within an epoch, or applied at full weight per vote? Determines whether
   the per-epoch "power allocation" is a real constraint. Confirm against the
   contracts; the Budget manager is built to handle either (degenerate case =
   vote on all qualifying pods).
3. **Whether minting a pod costs REPPO** (beyond gas) and any per-datanet access
   fee interplay — sizes the mint pool.
4. **Model-agnostic judgment quality floor** — weak models scoring pods on
   staked decisions is a risk; recommend a minimum-capability guard or let
   strictness compensate.

## Phased build order

- **Phase 1 — generic core, one adapter (end-to-end):** runtime + scheduler,
  rubric loader (from Reppo metadata), generic Voter, Budget/Wallet manager
  (lock + caps + ledger), onboarding wizard, the `hyperliquid` adapter, Docker
  packaging. Result: a self-hosted host that votes generically on any datanet and
  mints on TradingGymAI — through the generic architecture, not a special case.
- **Phase 2 — adapter SDK + a second adapter:** formalize/publish the adapter
  interface and add one non-trading adapter to prove generality.
- **Phase 3 — polish:** optional local dashboard, outcome-based strategy
  auto-tuning (learn from emissions earned), adapter marketplace/registry.

## Non-goals

- Custodial key management, hardware/remote signers (Phase-later if demanded).
- A hosted/managed multi-tenant service (this is self-host).
- Autonomous LLM data sourcing for datanets without an adapter (vote-only there).
- Reworking aeon itself — the reppo skills are *extracted*, not migrated in place.

## Testing / verification

- Unit: rubric loader parses metadata; strictness→threshold mapping; budget
  manager refuses out-of-cap intents; dedup.
- Integration: a dry-run cycle against a captured datanet-metadata + pod snapshot
  asserts correct vote directions and that no signing occurs without budget.
- Adapter contract test: `hyperliquid.discover()` produces schema-valid
  candidates from a captured leaderboard/fills fixture.
- End-to-end (testnet/small budget): one real cycle locks veREPPO, casts a vote,
  and respects the cap; budget ledger persists across a restart.
