# Orquestra HL Adapter Data-Sourcing Redesign — Design

**Date:** 2026-06-06
**Status:** Draft design; pending review → implementation plan
**Depends on:** `fix/hl-adapter-mint-path` (round-trip reconstruction + dataset-aware
scoring — PR #2). This redesign builds on that.
**Goal:** Make the Hyperliquid adapter source **complete, high-signal, verifiable**
trade datasets that actually clear datanet 9's voter rubric — and pair shipping it
with a **live test that measures whether the resulting pods earn emissions**, before
any investment in expanding minting to more datanets (templates).

---

## Why (evidence from the investigation)

The live node minted zero pods on datanet 9. Two bugs were fixed (PR #2): the scorer
was blind to the dataset, and metrics were computed per-fill not per-position. With
those fixed, candidates are now scored on honest data — and **still score below the
mint threshold**, because the *data itself* is low-value:

1. **Rolling 7-day `userFillsByTime` window truncates positions.** Top-leaderboard
   wallets are mid-position; we capture their closes but not their opens, so
   `entry_px=null`, and each wallet yields only 1–2 round-trips. The rubric demands
   "entry + sizing + exit, verifiable" — truncated data can't provide it.
2. **Ranking window ≠ labeling window.** `rankByMargin` selects on the leaderboard's
   "week" metric, but the labeled data is the in-window realized closes. A wallet
   ranked top-margin showed **−$54,509** realized in our window. We rank "winners"
   whose minted data shows losses.
3. **Selection floor is on raw fills, not positions.** The 20-closed-*fill* floor
   passes thin wallets (1 position split across 20 partial fills).

### G1 economics finding (blocking context)

True mint PnL on datanet 9, from on-chain + local data:
- 14 historical `mint-pod` txs succeeded; total gas **0.000019 ETH** (negligible), 0 REPPO.
- **0** emissions ever claimed (claim feature only shipped 2026-06-03); **0** currently
  claimable; **0** pods attributed to our wallet across epochs 70–102.
- **Net realized revenue from minting ≈ 0.** No evidence minting on #9 has ever paid.

**Consequence:** this redesign must improve not just "passes the scorer" but "produces
pods that win votes and earn emissions." Hence the live earn-test below is part of the
deliverable, not optional.

## Decisions

1. **Widen + epoch-align the fills window** so positions are captured whole.
2. **Rank by realized PnL from the same window we label** (leaderboard = candidate pool
   only).
3. **Quality-gate on reconstructed round-trips**, not raw fills.
4. **Ship behind a measured live earn-test** before any template-expansion work.

## Design

### A. Capture complete positions — widen + epoch-align the window

- `fetchFills(wallet)` currently uses `startTime = now − 7d`. Change to a window that
  captures whole round-trips: **align to the datanet's current validity epoch**
  (`queryEpochJson()` → `epochStart`/`epochDurationSeconds`) and extend back far enough
  that most in-epoch closes have their opens in-window (configurable lookback, e.g.
  `max(epochStart − openLookbackDays, …)`; default lookback a tunable param).
- Ties into the dedup spec's epoch-aligned keys (B1): a stable, complete window makes
  the dataset deterministic across operators *and* complete enough to carry entry data.
- **To confirm at implementation:** HL `userFillsByTime` max lookback + pagination
  (volume per wallet over a longer window); page if needed.

### B. Rank on realized, in-window performance (not the leaderboard metric)

- Keep the leaderboard as a **candidate pool** (cheap way to find active wallets).
- For each candidate, reconstruct round-trips over the chosen window and compute
  **realized PnL, win rate, and completeness** from THAT — then rank/select on it.
- Eliminates the rank/label contradiction (no more top-ranked wallet with in-window
  losses). `rankByMargin`'s role shrinks to a pre-filter (active + liquid).

### C. Quality gate on round-trips

Select a wallet only if its reconstructed history meets a rubric-aligned bar:
- ≥ N **complete** round-trips (both open and close in-window → `entry_px` present),
- positive realized PnL over the window,
- spread across ≥ M markets/days (not one lucky position),
- verifiable (tx hashes present).

Replaces the raw-fill floor. Directly targets "entry + sizing + exit, verifiable."

### D. Live earn-test (part of the deliverable)

After shipping A–C:
1. Run real cycles minting a **small** number of genuinely-high-quality pods on #9
   (budget caps already bound exposure; gas is negligible).
2. Over the next epoch(s), measure via the existing claim phase + dashboard: do these
   pods accrue **claimable/claimed emissions**? Track upvotes vs downvotes.
3. **Decision gate:** only if pods demonstrably earn (net positive after costs) do we
   proceed to the template-expansion program. If not, minting stays off / voting-only.

## Components / changes (sketch)

- `src/adapter/hyperliquid/index.ts` — `fetchFills` window (epoch-aligned + lookback,
  paginated); `discover()` reconstructs round-trips per candidate and ranks on realized
  in-window performance; quality gate before emitting candidates.
- `src/adapter/hyperliquid/rank.ts` — demote to a candidate-pool pre-filter (active +
  liquid), or replace with realized-PnL ranking computed from fills.
- `src/adapter/hyperliquid/dataset.ts` — already reconstructs round-trips (PR #2); add
  the completeness/quality summary used by the gate.
- Params (tie into the templates spec's `adapterParams`): `openLookbackDays`,
  `minRoundTrips`, `minMarkets`, `minRealizedPnl`.
- No change to the safety boundary (adapters never sign; budget caps unchanged).

## Testing

- Round-trip completeness: a wallet whose opens are in-window yields `entry_px`-present
  trips; quality gate accepts/rejects per the bar (fixtures).
- Realized-PnL ranking: a leaderboard "winner" with in-window losses is NOT selected.
- Window: epoch-aligned bounds computed from a fixture epoch; pagination assembles a
  full window (injected fake fetcher asserts page calls).
- Live earn-test is manual/observational (needs real cycles + epochs), tracked via the
  dashboard PnL + activity log — not CI.

## Risks / open questions

- **HL lookback limits** may cap how far back we can fetch (volume/pagination). If a
  full open-capturing window isn't feasible, completeness stays partial — surface
  `entry_px=null` honestly and let the quality gate reject.
- **Even complete, good data may not win votes/emissions** — that's exactly what the
  live earn-test measures. This redesign de-risks data quality, not market demand.
- **Cost:** longer windows = more fetch + scoring tokens per wallet; the round-trip
  quality gate should shrink the candidate set to offset.

## Out of scope

- Template-expansion to other datanets (gated on the earn-test).
- Cross-operator dedup mechanics (separate spec; this only adopts the epoch-aligned
  window that dedup also needs).
- A non-HL adapter.
