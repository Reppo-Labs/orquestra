# Orquestra Dashboard — Design

**Date:** 2026-06-03
**Status:** Approved (design); pending implementation plan
**Goal:** A read-only web dashboard, served from inside the orquestra container on
`localhost`, showing the node's past votes/mints, spend, and earned-emissions PnL.

---

## Problem

The orquestra node is a headless scheduler loop. After each cycle it only persists:

- `vote-state.json` — dedup IDs (which pods were voted/minted), no timestamps/txHashes/reasons.
- `budget-ledger.json` — cumulative spend counters + current cycleId.

The rich per-action result (direction, conviction, reason, txHash, gas) is computed
each cycle but only `console.error`'d as a count, then discarded. An operator has no
way to see *what the swarm did* or *how it's performing*.

This feature adds (1) a persisted activity log + on-chain snapshot written each cycle,
and (2) a lean embedded HTTP server that renders them.

## Decisions (locked during brainstorming)

1. **PnL scope = spend + earned emissions.** Feasible entirely via the reppo CLI:
   - `reppo query emissions-due --json` → unclaimed REPPO emissions across our pods.
   - `reppo list pods --include-emissions` → our pods with emissions data.
   - `reppo query voting-power --json` → veREPPO power + lockup count.
   - `reppo query balance --json` → ETH/REPPO/veREPPO/USDC.
   - Spend comes from `budget-ledger.json` (local). No raw contract calls.
   - The local dev CLI is 0.5.0; the container runs 0.7.0. Exact JSON shapes are
     confirmed against 0.7.0 at integration (same convention as the other wrappers).
2. **Serving layer = embedded HTTP + static HTML.** A tiny server (Node's built-in
   `http`, no framework, no build step) in the same node process. One port, near-zero
   new deps. Read-only.
3. **Data freshness = snapshot each cycle.** The scheduler writes a snapshot file at
   the end of every cycle; the dashboard reads files only. The server never touches the
   wallet/signing surface. The UI shows an "as of <last cycle>" timestamp. Freshness =
   the configured cadence.

## Architecture

```
Container (single node process)
├─ scheduler loop ── each cycle: vote/mint
│     ├─ append each executed action → activity-log.jsonl
│     └─ collect on-chain view      → snapshot.json   (atomic overwrite, merge-on-partial)
└─ http server :7070  (read-only — NEVER imports the executor/private key)
      GET /              → index.html  (vanilla JS, no build step)
      GET /api/activity  → parsed activity-log.jsonl (votes/mints history)
      GET /api/pnl       → snapshot.json + derived earned-vs-spent summary
      GET /api/config    → safe config subset (datanets/cadence — secrets stripped)
```

## Persisted files (in `ORQUESTRA_DATA_DIR`)

### `activity-log.jsonl` — append-only, one JSON object per line

Crash-safe: each entry is a single appended line; the reader tolerates a torn final
line (a crash mid-write loses at most the last entry, never the file).

```jsonc
{
  "ts": "2026-06-03T21:38:38.651Z",   // ISO-8601, when the action executed
  "cycleId": "2026-06-03T21:38:38.651Z",
  "kind": "vote",                      // "vote" | "mint"
  "datanetId": "9",
  "podId": "123",                      // vote only
  "direction": "up",                   // vote only: "up" | "down"
  "conviction": 9,                     // vote only: 1-10
  "reason": "strong rubric alignment", // vote only
  "canonicalKey": "sha256:…",          // mint only
  "podName": "TradingGym snapshot …",  // mint only
  "status": "executed",                // "executed" | "refused-budget" | "error"
  "txHash": "0x…",                     // present when executed
  "gasEth": 0.00012,                   // present when known
  "detail": ""                         // optional human note (e.g. error message)
}
```

### `snapshot.json` — overwritten each cycle (atomic tmp+rename)

```jsonc
{
  "ts": "2026-06-03T21:38:40.000Z",
  "cycleId": "2026-06-03T21:38:38.651Z",
  "balance": { "eth": 0.42, "reppo": 1850.0, "veReppo": 500.0, "usdc": 0 },
  "votingPower": { "power": 500.0, "lockupCount": 1 },
  "emissionsDue": {
    "totalReppo": 12.5,
    "pods": [ { "podId": "123", "datanetId": "9", "epoch": 101, "reppo": 12.5 } ]
  },
  "budget": {
    "mintReppoSpent": 100.0, "mintGasSpentEth": 0.003,
    "voteGasSpentEth": 0.0011,
    "caps": { "voteGasEthMax": 0.05, "voteRateMaxPerCycle": 30, "mintReppoMax": 500, "mintGasEthMax": 0.05 }
  }
}
```

`collectSnapshot` **merges over the last snapshot**: if a sub-call (e.g. balance) fails
this cycle, the previous value is retained rather than blanked. A first-ever cycle with
a failing sub-call writes only the sections that succeeded.

## Modules (lean, single-responsibility, testable)

| File | Responsibility | Tested |
|------|----------------|--------|
| `src/dashboard/activityLog.ts` | `appendActivity(dataDir, entry)`, `readActivity(dataDir, {limit})` — JSONL append + parse, tolerate torn final line | unit (temp dir) |
| `src/dashboard/snapshot.ts` | `writeSnapshot()` (atomic), `readSnapshot()` (null if absent), `collectSnapshot(readers)` (merge-on-partial) | unit (DI fakes) |
| `src/dashboard/pnl.ts` | pure `derivePnl(snapshot)` → `{ earnedReppo, spentReppo, netReppo, gasSpentEth, … }` | unit |
| `src/reppo/queryEmissionsDue.ts` | thin CLI wrapper + pure `parseEmissionsDue(raw)` | unit (fixture) |
| `src/reppo/queryVotingPower.ts` | thin CLI wrapper + pure `parseVotingPower(raw)` | unit (fixture) |
| `src/dashboard/server.ts` | `startDashboard(dataDir, port)` → Node `http` server; routes above; per-handler try/catch → 500 JSON; returns `{ close() }` | integration (ephemeral port) |
| `src/dashboard/index.html` | one self-contained page: PnL card, votes/mints table (filter by datanet, newest-first), emissions-by-pod table, spend-vs-caps bars; inline SVG; no framework | n/a (manual) |

New CLI wrappers go through the existing `withRpcUrl`/`reppoEnv` helpers so they honour
`RPC_URL`.

## Changes to existing code

- **`src/wallet/intents.ts` (`ExecResult`):** add optional `gasEth?: number`. The
  executor already computes actual gas in `reconcileVote`/`reconcileMint`; surface it so
  per-action gas reaches the activity log. Additive — no caller breaks.
- **`src/wallet/executor.ts`:** populate `gasEth` on the returned `ExecResult`.
- **`src/runtime/cycle.ts` (`CycleDeps`):** add `recordActivity(entry)` callback, invoked
  right after each `executeVote`/`executeMint` (both intent + result in scope), mirroring
  the existing `recordVote`/`recordMint`. Keeps `cycle.ts` pure and testable.
- **`src/index.ts`:** the cycle callback (a) appends activity entries, (b) calls
  `collectSnapshot` + `writeSnapshot` — both wrapped to never throw into the scheduler
  loop. `start()` launches `startDashboard(DATA_DIR, port)` when enabled and adds its
  handle to the SIGINT/SIGTERM shutdown.
- **Env:** `DASHBOARD_PORT` (default `7070`), `DASHBOARD_ENABLED` (default `true`).
- **`Dockerfile`:** `EXPOSE 7070`.
- **`.env.example`:** document `DASHBOARD_PORT`, `DASHBOARD_ENABLED`, and the
  `-p 127.0.0.1:7070:7070` mapping for localhost-only exposure.

## Error handling

- Server: each handler wrapped → returns 500 JSON on failure, never crashes the process.
- Missing data files → empty payloads. A fresh node (no cycles yet) renders cleanly with
  empty tables + "PnL pending first cycle."
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
  merge-on-partial, read-null), `pnl` derivation, `parseEmissionsDue` + `parseVotingPower`
  (fixtures).
- **Server integration:** start on an ephemeral port, fetch each route, assert JSON
  shapes, a 404 for unknown paths, and that `/api/config` leaks no secret.
- **`collectSnapshot`:** injected fake readers (DI), matching the existing test pattern.
  The live CLI wrappers are typecheck/build-only.

## Out of scope (this phase)

- Full per-pod attributed PnL over time (emissions minus mint cost+gas per pod, with
  historical balance snapshots) — a possible later phase.
- Claiming emissions from the dashboard (read-only by design; claiming is a signing action).
- Authentication / multi-user / remote exposure.
