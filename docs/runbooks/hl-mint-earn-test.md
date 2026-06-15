# Runbook: HL mint earn-test (does a minted pod actually earn?)

**Why:** G1 showed minting on datanet 9 has never produced measurable emissions (0
claimed, 0 due, 0 pods attributed to our wallet). Before expanding minting to more
datanets (the template program), prove a *good* pod earns.

## Procedure
1. Deploy the redesigned adapter (design:
   `../superpowers/specs/2026-06-06-orquestra-hl-adapter-redesign-design.md`) to the
   live node — rebuild the image and redeploy.
2. Keep budget caps small, but note each mint reserves a conservative ~200 REPPO
   against `mintReppoMax` before signing (the CLI omits the fee; the node assumes the
   max observed unless `RPC_URL` is set to read the real one). So `mintReppoMax` must be
   ≥ ~200 to mint at all — use e.g. `mintReppoMax` 400 for a few test mints. Mint gas on
   Base is negligible (~0.0000013 ETH/tx observed), so gas exposure is tiny.
3. Let the node run; confirm it mints a handful of pods on datanet 9 (dashboard →
   Activity → kind=mint, status=executed). If it mints 0, the quality gate is rejecting
   everything → revisit params (`openLookbackDays`, `minRoundTrips`) or data sourcing.
   **Do NOT loosen the gate just to force mints** — that recreates the original bug
   (minting low-value data that gets downvoted).
4. Over the next 1–2 epochs, watch the dashboard:
   - Do our minted pods accrue **upVotes** (curators valuing the data)?
   - Does **emissions-due** / **claimed** become non-zero for our pods? (the claim phase
     runs each cycle.)
5. Record per-pod: epoch, upVotes/downVotes, REPPO earned, gas spent.

## Decision gate
- **Earns net-positive** (emissions > mint+gas cost over the horizon) → proceed to the
  template-expansion program (more datanets).
- **Earns ~0 / net-negative** → minting stays off / voting-only; revisit data sourcing
  or conclude this datanet isn't worth minting on.

## Observations (recorded during the redesign — Task 6 live validation, 2026-06-06)
- With default params (`openLookbackDays` 45, gate: ≥3 complete round-trips, ≥2 markets,
  realized PnL ≥ 0), live `discover()` on datanet 9 returned **5 gate-passing candidates**
  (was 0 before the redesign), with plausible win rates (50–100% over 5–17 round-trips)
  and `entry_px` populated on most trips (e.g. 11/17, 8/14).
- **Latency:** discover took ~65s — the longer window paginates more fills across the
  candidate pool. Fine for the 6h cadence; if it grows, lower `poolSize` or page caps.
- **HL `userFillsByTime` lookback/pagination:** the 45-day window returned within limits
  using forward paging (cursor = last fill time + 1, ≤50 pages, ~2000 fills/page). No
  lookback cap hit at 45 days. Re-check if extending the window much further.
- Completeness is partial (some trips still `entry_px=null` where the open predates even
  the 45-day window) — the quality gate counts only complete trips, so this is handled
  honestly rather than hidden.

## Notes
- This measures **market demand** (do curators want the data), which code quality alone
  cannot establish. The redesign de-risks data *quality*; this test de-risks data *value*.
