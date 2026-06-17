# Overview emissions panel — design

**Date:** 2026-06-17
**Status:** Approved (design); implementation pending
**Author:** Ana (with Claude Code)
**Repo:** orquestra (web dashboard)

## Problem

Surface **past emissions claimed** + **claimable now** prominently on the dashboard
Overview tab. Both figures already exist and render today — but they're buried among
the general PnL cards (Earned / Spent / Gas / Balance / veREPPO / Epoch), so the
node's earning story isn't at-a-glance. Give emissions a dedicated, prominent panel.

## What already exists (verified)

- `/api/pnl` returns `pnl.claimedReppo`, `pnl.claimableReppo`, `pnl.earnedReppo`
  (`src/dashboard/pnl.ts`): `claimedReppo` = sum of executed claim activity
  (`reppoClaimed`); `claimableReppo` = `snapshot.emissionsDue.totalReppo` (live
  `reppo query emissions-due`); `earnedReppo` = claimed + claimable.
- Web `Pnl` type (`web/src/api.ts`) already carries all three.
- They currently show as rows in `web/src/components/PnlCards.tsx` (Claimed,
  Claimable, Earned) + the earn banner (`App.tsx`); the per-pod claimable breakdown
  is the `Emissions` table (`web/src/components/Emissions.tsx`).

**No backend change is needed** — this is a frontend layout change only.

## Decisions (settled during brainstorming)

1. **Dedicated prominent Emissions panel** at the TOP of the Overview tab (above the
   PnL cards), headlining Claimed + Claimable as the stat pair.
2. **De-dupe:** remove `Claimed` / `Claimable` / `Earned` from `PnlCards` — they live
   only in the new panel. `PnlCards` keeps Spent / Gas / Balance / veREPPO / Epoch.
3. Keep the existing per-pod `Emissions` table below as the detail breakdown
   (unchanged).

## Design

### Component: `web/src/components/EmissionsSummary.tsx` (new)
A panel consuming the existing `Pnl` object:
- Headline stat pair: **Claimed (all-time)** = `pnl.claimedReppo`, **Claimable now** =
  `pnl.claimableReppo` (rendered large/prominent, formatted via the existing `fmt`
  helper used by `PnlCards`).
- Sub-line: **Earned total** = `pnl.earnedReppo`, plus a short note "claims run
  automatically each cycle".
- Zero/empty state: renders `0 REPPO` cleanly (a fresh node with no matured claims
  shows Claimed `0` — correct, not an error). Renders nothing only if `pnl` is null
  (mirror how `PnlCards`/`App` guard a missing pnl today).

Layout: match the existing dashboard card/panel styling (reuse the same CSS classes
`PnlCards`/`Emissions` use; no new design system). A two-column stat header with a
divider above the Earned/total line — consistent with the existing panels.

### `App.tsx` (Overview tab)
Render `<EmissionsSummary pnl={pnl} />` at the top of the Overview content, above
`<PnlCards />`. Pass the same `pnl` already loaded from `/api/pnl`.

### `PnlCards.tsx`
Remove the `Claimed`, `Claimable`, and `Earned` card rows (now in the panel). Keep
`Spent` (mint REPPO), `Gas` (ETH), `REPPO balance`, `veREPPO`, `Epoch`. No prop
changes (still receives `pnl` + `snapshot`).

### Data flow
`App.loadAll` → `/api/pnl` → `{ pnl, snapshot }` (unchanged). `EmissionsSummary`
reads `pnl.claimedReppo` / `claimableReppo` / `earnedReppo`. The earn banner
(`App.tsx`) and the per-pod `Emissions` table are left as-is.

## Testing
- `npm --prefix web run typecheck` + `npm --prefix web run build` green (the web
  package has no `.tsx` test harness; verified via typecheck + build, matching how
  the per-datanet and node-default pickers were verified).
- Manual: Overview shows the Emissions panel up top with Claimed + Claimable; the
  three rows no longer duplicated in PnlCards; zero-claimed renders `0 REPPO`.

## Out of scope
- Any backend/endpoint change (figures already served by `/api/pnl`).
- Over-time / per-epoch history or a chart (only the prominent current totals).
- The per-pod `Emissions` table and the earn banner (unchanged).
- Relabeling beyond the new panel's own labels.
