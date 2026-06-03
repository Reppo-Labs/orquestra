# Orquestra Dashboard + Emissions Claiming — Design

**Date:** 2026-06-03
**Status:** Approved (design); pending implementation plan
**Goal:** (1) The swarm cycle claims earned REPPO emissions for our pods each cycle.
(2) A read-only web dashboard, served from inside the orquestra container on `localhost`,
shows past votes/mints/**claims**, spend, claimable + claimed emissions, and PnL.

---

## Problem

The orquestra node is a headless scheduler loop. After each cycle it only persists:

- `vote-state.json` — dedup IDs (which pods were voted/minted), no timestamps/txHashes/reasons.
- `budget-ledger.json` — cumulative spend counters + current cycleId.

Two gaps: (a) earned emissions just sit unclaimed on-chain — the node never collects
them; (b) the rich per-action result (direction, conviction, reason, txHash, gas) is
computed each cycle but only `console.error`'d as a count, then discarded, so an operator
can't see what the swarm did or how it's performing.

This feature adds: a **claim phase** in the cycle (collect earned emissions), a persisted
**activity log** + **on-chain snapshot** written each cycle, and a lean embedded HTTP
server that renders them.

## Decisions (locked during brainstorming)

1. **PnL scope = spend + earned emissions.** Feasible entirely via the reppo CLI:
   - `reppo query emissions-due --json` → unclaimed REPPO emissions across our pods (per pod, per epoch).
   - `reppo query voting-power --json` → veREPPO power + lockup count.
   - `reppo query balance --json` → ETH/REPPO/veREPPO/USDC.
   - Spend comes from `budget-ledger.json` (local). No raw contract calls.
   - The local dev CLI is 0.5.0; the container runs 0.7.0. Exact JSON shapes are
     confirmed against 0.7.0 at integration (same convention as the other wrappers).
2. **The swarm claims emissions, every cycle.** A claim phase reads `emissions-due` and
   claims every unclaimed (pod, epoch) via `reppo claim-emissions`. No amount threshold
   (keeps claimable ≈ 0). Claiming is a **signing action** → it goes through
   `WalletExecutor` with gas reserve-before-sign and a **claim gas cap**; when the cap is
   hit, remaining claims are refused this cycle (resume next cycle). Idempotent per
   (pod, epoch). A single global toggle `claimEmissions` (default `true`) disables it.
3. **Serving layer = embedded HTTP + static HTML.** A tiny server (Node's built-in
   `http`, no framework, no build step) in the same node process. One port, near-zero
   new deps. **Read-only** — it displays claims/claimable but never itself claims/signs.
4. **Data freshness = snapshot each cycle.** The scheduler writes a snapshot file at the
   end of every cycle (after claiming); the dashboard reads files only. The server never
   touches the wallet/signing surface. The UI shows an "as of <last cycle>" timestamp.

## Architecture

```
Container (single node process)
├─ scheduler loop ── each cycle:
│     ├─ per datanet: vote / mint
│     ├─ claim phase: query emissions-due → claim each unclaimed (pod,epoch)
│     ├─ append every executed action (vote|mint|claim) → activity-log.jsonl
│     └─ collect on-chain view → snapshot.json   (atomic overwrite, merge-on-partial)
└─ http server :7070  (read-only — NEVER imports the executor/private key)
      GET /              → index.html  (vanilla JS, no build step)
      GET /api/activity  → parsed activity-log.jsonl (votes/mints/claims history)
      GET /api/pnl       → snapshot.json + derived earned-vs-spent summary
      GET /api/config    → safe config subset (datanets/cadence — secrets stripped)
```

## Persisted files (in `ORQUESTRA_DATA_DIR`)

### `activity-log.jsonl` — append-only, one JSON object per line

Crash-safe: each entry is a single appended line; the reader tolerates a torn final
line (a crash mid-write loses at most the last entry, never the file).

```jsonc
// vote / mint entry
{
  "ts": "2026-06-03T21:38:38.651Z", "cycleId": "2026-06-03T21:38:38.651Z",
  "kind": "vote",                       // "vote" | "mint" | "claim"
  "datanetId": "9",
  "podId": "123",                       // vote/claim
  "direction": "up",                    // vote only: "up" | "down"
  "conviction": 9,                      // vote only: 1-10
  "reason": "strong rubric alignment",  // vote only
  "canonicalKey": "sha256:…",           // mint only
  "podName": "TradingGym snapshot …",   // mint only
  "status": "executed",                 // "executed" | "refused-budget" | "error"
  "txHash": "0x…", "gasEth": 0.00012, "detail": ""
}
// claim entry
{
  "ts": "2026-06-03T21:38:39.900Z", "cycleId": "2026-06-03T21:38:38.651Z",
  "kind": "claim", "datanetId": "9", "podId": "123",
  "epoch": 101,
  "reppoClaimed": 12.5,                 // emissions-due amount claimed
  "status": "executed", "txHash": "0x…", "gasEth": 0.00009, "detail": ""
}
```

### `snapshot.json` — overwritten each cycle (atomic tmp+rename)

`emissionsDue` here reflects **claimable after this cycle's claims** (≈ 0 in steady
state; non-zero only for amounts refused by the gas cap or that failed to claim).

```jsonc
{
  "ts": "2026-06-03T21:38:40.000Z", "cycleId": "2026-06-03T21:38:38.651Z",
  "balance": { "eth": 0.42, "reppo": 1850.0, "veReppo": 500.0, "usdc": 0 },
  "votingPower": { "power": 500.0, "lockupCount": 1 },
  "emissionsDue": {
    "totalReppo": 0.0,
    "pods": [ /* { podId, datanetId, epoch, reppo } for any still-unclaimed */ ]
  },
  "budget": {
    "mintReppoSpent": 100.0, "mintGasSpentEth": 0.003,
    "voteGasSpentEth": 0.0011, "claimGasSpentEth": 0.0007,
    "caps": { "voteGasEthMax": 0.05, "voteRateMaxPerCycle": 30, "mintReppoMax": 500, "mintGasEthMax": 0.05, "claimGasEthMax": 0.05 }
  }
}
```

`collectSnapshot` **merges over the last snapshot**: if a sub-call (e.g. balance) fails
this cycle, the previous value is retained rather than blanked.

### `vote-state.json` (existing) — gains `claimedKeys`

`DedupState` adds a third map `claimedKeys: Record<datanetId, string[]>` where each value
is `"${podId}:${epoch}"`, so a claimed (pod, epoch) is never re-attempted.

## PnL derivation (pure, in `src/dashboard/pnl.ts`)

`derivePnl(snapshot, activity)` →

```jsonc
{
  "claimedReppo":   163.0,   // Σ reppoClaimed over executed claim activity entries
  "claimableReppo": 0.0,     // snapshot.emissionsDue.totalReppo (still unclaimed)
  "earnedReppo":    163.0,   // claimed + claimable
  "spentReppo":     100.0,   // snapshot.budget.mintReppoSpent
  "netReppo":       63.0,    // earned − spent
  "gasSpentEth":    0.0048   // vote + mint + claim gas
}
```

## Modules (lean, single-responsibility, testable)

| File | Responsibility | Tested |
|------|----------------|--------|
| `src/dashboard/activityLog.ts` | `appendActivity(dataDir, entry)`, `readActivity(dataDir, {limit})` — JSONL append + parse, tolerate torn final line | unit (temp dir) |
| `src/dashboard/snapshot.ts` | `writeSnapshot()` (atomic), `readSnapshot()` (null if absent), `collectSnapshot(readers)` (merge-on-partial) | unit (DI fakes) |
| `src/dashboard/pnl.ts` | pure `derivePnl(snapshot, activity)` → summary above | unit |
| `src/reppo/queryEmissionsDue.ts` | thin CLI wrapper + pure `parseEmissionsDue(raw)` → `[{podId,datanetId,epoch,reppo}]` | unit (fixture) |
| `src/reppo/queryVotingPower.ts` | thin CLI wrapper + pure `parseVotingPower(raw)` | unit (fixture) |
| `src/dashboard/server.ts` | `startDashboard(dataDir, port)` → Node `http` server; routes above; per-handler try/catch → 500 JSON; returns `{ close() }` | integration (ephemeral port) |
| `src/dashboard/index.html` | one self-contained page: PnL card (earned/claimed/claimable/spent/net), votes·mints·claims table (filter by datanet + kind, newest-first), claimable-by-pod table, spend-vs-caps bars; inline SVG; no framework | n/a (manual) |

New CLI wrappers go through the existing `withRpcUrl`/`reppoEnv` helpers so they honour
`RPC_URL`.

## Changes to existing code

### Claiming subsystem
- **`src/wallet/intents.ts`:** add `ClaimIntent { kind:'claim'; datanetId; podId; epoch; reppoDue; idempotencyKey }`; add optional `gasEth?: number` to `ExecResult` (the executor already computes actual gas in `reconcile*` — surface it for the activity log).
- **`src/reppo/cli.ts` (`ReppoCli`):** add `claimEmissions(args: { podId; epoch; idempotencyKey }): Promise<ChainResult>` → `run(['claim-emissions','--pod',podId,'--epoch',epoch,'--idempotency-key',key])`.
- **`src/wallet/ledger.ts` (`BudgetLedger`/`BudgetCaps`):** add `claimGasEthMax` cap + `claimGasSpentEth` cumulative; add `canClaim()`, `reserveClaim(estGasEth)`, `reconcileClaim`, `releaseClaim` (mirror the vote-gas reserve→reconcile/release pattern).
- **`src/wallet/executor.ts`:** add `executeClaim(intent)` → `reserveClaim` → `cli.claimEmissions` → `reconcileClaim`/`releaseClaim`; populate `gasEth` on every returned `ExecResult` (vote/mint/claim).
- **`src/runtime/state.ts` (`DedupState`):** add `getClaimedKeys(datanetId)` + `recordClaim(datanetId, key)` over a new `claimedKeys` map.
- **`src/runtime/cycle.ts`:** after the per-datanet vote/mint loop, run a **global claim phase** (emissions-due is one query across all pods): `getEmissionsDue()` → filter out `claimedKeys` → per-claim try/catch isolation → `executeClaim` → `recordActivity` + `recordClaim` (unless `refused-budget`). `CycleReport` becomes `{ datanets: DatanetReport[]; claims: ExecResult[] }`. Add `getEmissionsDue()`, `recordActivity(entry)`, `recordClaim(datanetId,key)` to `CycleDeps`.
- **`src/config/schema.ts`:** add global `claimEmissions: boolean` (default `true`); add `claimGasEthMax` to the budget caps (sensible default, e.g. `0.05`). Onboarding defaults it on without a new question.

### Dashboard wiring
- **`src/runtime/cycle.ts` (`recordActivity`):** invoked right after each `executeVote`/`executeMint`/claim (intent + result in scope), mirroring `recordVote`/`recordMint`. Keeps `cycle.ts` pure.
- **`src/index.ts`:** implements `recordActivity` (append JSONL) and `getEmissionsDue`; the cycle callback also calls `collectSnapshot` + `writeSnapshot` — all wrapped to never throw into the loop. `start()` launches `startDashboard(DATA_DIR, port)` when enabled and adds its handle to the SIGINT/SIGTERM shutdown. Cycle count log includes claims.
- **Env:** `DASHBOARD_PORT` (default `7070`), `DASHBOARD_ENABLED` (default `true`).
- **`Dockerfile`:** `EXPOSE 7070`.
- **`.env.example`:** document `DASHBOARD_PORT`, `DASHBOARD_ENABLED`, and the
  `-p 127.0.0.1:7070:7070` mapping for localhost-only exposure.

## Error handling

- Server: each handler wrapped → returns 500 JSON on failure, never crashes the process.
- Missing data files → empty payloads. A fresh node renders cleanly with empty tables +
  "PnL pending first cycle."
- Claim phase: per-claim isolation — one failing/refused claim skips that (pod, epoch),
  never the rest. A claim recorded with status `error` is still added to `claimedKeys`
  (fail-safe toward not re-attempting a possibly-landed tx), same convention as vote/mint.
- Activity append / snapshot write failures in the cycle callback are logged and
  swallowed — they must never abort a cycle or orphan a just-landed on-chain action.
- `collectSnapshot` sub-call failures merge over the last snapshot (no blank cards).

## Security

- The dashboard server is **read-only**: it never imports `WalletExecutor`,
  `defaultReppoCli`, or the private key. `/api/config` returns only a safe subset
  (datanets, cadence, strictness) — never `REPPO_PRIVATE_KEY` or LLM keys.
- No application-level auth (local-only by design). Exposure is bounded by the docker
  `-p` mapping; the recommended mapping binds to `127.0.0.1`.

## Testing

- **Unit:** `activityLog` (append/read/partial-line/limit), `snapshot` (atomic write,
  merge-on-partial, read-null), `pnl` derivation (claimed Σ from log + claimable from
  snapshot), `parseEmissionsDue` + `parseVotingPower` (fixtures), `BudgetLedger` claim
  caps (reserve/reconcile/release + refuse-at-cap), `DedupState` claimedKeys.
- **Cycle:** claim phase with injected fakes — claims unclaimed, skips already-claimed,
  per-claim isolation, refuses past the gas cap, records activity + claimedKeys.
- **Executor:** `executeClaim` reserve→sign→reconcile, release-on-failure, `gasEth` surfaced.
- **Server integration:** start on an ephemeral port, fetch each route, assert JSON
  shapes, a 404 for unknown paths, and that `/api/config` leaks no secret.
- Live CLI wrappers (`queryEmissionsDue`, `queryVotingPower`, `cli.claimEmissions`) are
  typecheck/build-only; logic is exercised via injected fakes (DI), matching the codebase.

## Out of scope (this phase)

- Amount/gas-aware claim thresholds (REPPO→ETH price reference) — claim-everything for now.
- Full per-pod attributed PnL over time with historical balance snapshots — later phase.
- Triggering claims/votes/mints from the dashboard UI (read-only by design).
- Authentication / multi-user / remote exposure.
