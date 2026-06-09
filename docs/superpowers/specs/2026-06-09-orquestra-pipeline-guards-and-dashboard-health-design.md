# Orquestra: Pipeline Guards & Dashboard Health — Design

**Date:** 2026-06-09
**Status:** Approved
**Context:** Post PR #13 (Virtuals provider, grant-access, budget enforcement). The live node is leaking effort: every cycle it LLM-scores and attempts votes on datanets whose subnet access it cannot afford (`VOTER_LACKS_SUBNET_ACCESS` on #2/#11), minting on #2 is blocked by a pod-name length bug (`INVALID_POD_NAME: ≤50 chars, got 144`), a #9 mint reverted with undecoded `0x5dd58b8b`, and the live config has drifted from the repo copy (#11 voting and #9 minting despite config saying otherwise). `earn-status` reports `earning: false`.

Two parallel workstreams: **(1) fix the leaks** with targeted pipeline guards, **(2) extend the existing dashboard** so failures like these are visible at a glance.

## Workstream 1: Pipeline guards

### 1.1 Access gate in `runCycle`

`src/runtime/cycle.ts` already attempts a one-time `grant-access` per datanet (lines ~80–91) but deliberately proceeds when the grant fails ("let the vote surface the error"). That policy predates the budget gate: with `grantReppoMax: 0`, refusal is now *persistent*, so the node burns LLM inference and doomed vote attempts every cycle.

**Change:** after the existing grant attempt, if the datanet requires subnet access (`rubric.subnetUuid` set) and access is still not granted, **skip the datanet's vote and mint phases entirely** for this cycle:

- Record one structured activity entry per skipped datanet per cycle:
  `{ ts, cycleId, kind: 'skip', datanetId, reason: 'subnet access not granted: <grant status/detail>' }`
- Add `'skip'` to the `ActivityEntry` kind union in `src/dashboard/activityLog.ts`.
- Push a `DatanetReport` carrying a new optional `skipped: string` (reason) field so `CycleReport` stays honest.
- No config change needed to recover: the cycle after a successful grant (operator funds REPPO and raises `grantReppoMax`), voting resumes automatically.

Datanets whose rubric has no `subnetUuid` (pre-subnet-model metadata) are unaffected — they proceed as today.

### 1.2 Pod-name length enforcement (two layers)

The reppo CLI rejects `--pod-name` over 50 chars. The gdelt adapter (`src/adapter/gdelt/claim.ts:80`) uses the full LLM-generated claim text as `podName` (observed: 144 chars).

- **Root cause fix:** the gdelt claim prompt additionally emits a short `title` (≤50 chars); `podName` uses it. Fallback when the model overruns: word-boundary truncation of the claim to ≤50 chars.
- **Safety net:** clamp `podName` to 50 chars (word-boundary truncate) at mint-intent construction in `src/minter/select.ts`, so no current or future adapter can trip `INVALID_POD_NAME`. The full claim remains in `podDescription`; nothing is lost.

### 1.3 Config drift & revert decoding (ops + small code)

- **Config drift:** the live container is voting #11 and minting #9; the repo config disables both. Verify which config the deployed node mounts, sync it with the repo copy, redeploy, and confirm in the next cycle's activity log.
- **Revert decoding:** identify `0x5dd58b8b` (via `cast 4byte`, reppo CLI source, or the subnet contract ABI) and add it to the executor's error mapping (`src/wallet/executor.ts`) with a human-readable hint. If it indicates an affordability/access failure, guards 1.1 and the existing budget gate should prevent recurrence.

### 1.4 Testing

- `cycle.test.ts`: grant refused → `getPodsAndFilter`/adapter never called, one `skip` activity entry recorded, `DatanetReport.skipped` set; grant succeeds → behavior unchanged.
- gdelt tests: short-title path, fallback truncation path.
- `select.test.ts`: clamp applied; ≤50-char names pass through untouched.
- Live verification after deploy: one full cycle with zero `VOTER_LACKS_SUBNET_ACCESS` errors.

## Workstream 2: Dashboard health panels

The dashboard (`src/dashboard/server.ts` + `index.html`) already serves balances, claimable emissions, and an activity feed. Extend it — same vanilla-HTML card style, no framework.

### 2.1 New endpoint: `GET /api/health`

Backed by new `src/dashboard/health.ts`, aggregating the recent activity log (reuse `readActivity`, e.g. last 5000 entries) server-side:

- **Counts** by datanet × kind (vote/mint/claim/skip) × status (executed/refused/error/skipped).
- **Error codes** extracted from `detail`: the reppo CLI embeds `{"error":{"code":"..."}}` — tolerant JSON parse with regex fallback; unparseable details bucket as `UNKNOWN`. Report top error codes with counts per datanet.
- **Skip reasons:** most recent skip reason per datanet (from 1.1's entries).
- Read-only, like every other endpoint. Malformed log lines are skipped, matching `readActivity`'s tolerance.

Server-side aggregation keeps `index.html` dumb and makes the logic unit-testable, consistent with `pnl.ts`/`earnStatus.ts`.

### 2.2 New panels in `index.html`

1. **Cycle health** — one row per datanet: vote/mint executed · refused · error · skipped counts over the window, plus top error code (e.g. `VOTER_LACKS_SUBNET_ACCESS × 14`).
2. **Budget burn vs. caps** — bars for each cap in `snapshot.budget` (voteGasEth, mintReppo, grantReppo, claimGasEth): spent vs. max. Data already in `/api/pnl`'s snapshot; nothing new collected.
3. **Idle/skipped datanets** — for each configured-but-idle datanet, the reason from skip entries (e.g. "subnet access not granted — grant refused: grantReppoMax=0").

### 2.3 Testing

- `health.test.ts`: aggregation counts, error-code extraction (fixtures copied from real live failures), skip-reason surfacing, malformed-line tolerance.
- Manual render check against the live data dir.

## Out of scope

- A general intent-preconditions/validation layer (YAGNI — the three guards cover the observed failure modes).
- Funding REPPO / raising `grantReppoMax` / activating #2 minting (operator action, not code; unblocked by this work).
- New adapters; charting frameworks.

## Sequencing

The workstreams are independent except for one seam: panel 2.2(3) consumes the `skip` entries from 1.1. Build 1.1 first (or stub the `skip` kind in `ActivityEntry` first) so the dashboard work can proceed in parallel.
