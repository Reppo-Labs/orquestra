# Overview Emissions Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a prominent "Emissions" panel at the top of the dashboard Overview showing all-time **claimed** + currently **claimable** REPPO, and remove those (now-redundant) rows from the general PnL cards.

**Architecture:** Frontend-only. Both figures already come from `/api/pnl` (`pnl.claimedReppo`, `pnl.claimableReppo`, `pnl.earnedReppo`). Add a small `EmissionsSummary` component reusing the existing card styling, render it at the top of the Overview tab, and drop the Claimed/Claimable/Earned rows from `PnlCards`. No backend change.

**Tech Stack:** React + Vite + TypeScript (the `web/` package). Verified via `npm --prefix web run typecheck` + `npm --prefix web run build` — the web package has **no `.tsx` test harness** (matching how the per-datanet + node-default pickers were verified).

**Spec:** `docs/superpowers/specs/2026-06-17-overview-emissions-panel-design.md`

> Worktree root: `/Users/anajuliabittencourt/code/orquestra/.claude/worktrees/nifty-munching-waffle`. Branch `feat/overview-emissions-panel` (already created). Run commands from the root.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `web/src/components/EmissionsSummary.tsx` | create | Prominent Claimed + Claimable (+ Earned) panel from `Pnl`. |
| `web/src/App.tsx` | modify | Render `<EmissionsSummary>` at the top of the Overview tab. |
| `web/src/components/PnlCards.tsx` | modify | Remove the Claimed / Claimable / Earned card rows. |

`web/src/api.ts` is unchanged — `Pnl` already has `claimedReppo`, `claimableReppo`, `earnedReppo`.

---

### Task 1: Create the `EmissionsSummary` component

**Files:**
- Create: `web/src/components/EmissionsSummary.tsx`

- [ ] **Step 1: Confirm the styling classes + Pnl fields**

Run: `grep -nE "panel-box|\\.card|\\.hero|\\.k |\\.v |\\bpos\\b|muted|sub" web/src/styles.css | head -30`
Expected: confirms `panel-box`, `card`, `hero`, `k`, `v`, `pos` exist (used by `PnlCards`/`Emissions`). Note whether a small/secondary text class (e.g. `muted`, `sub`, `foot`) exists for the Earned sub-line. If none exists, use the `muted` class if present, otherwise an inline `style={{ opacity: 0.7, fontSize: '0.85em' }}` for the sub-line — do NOT invent a CSS class name that isn't in styles.css.

Also confirm `Pnl` has the fields: `grep -nE "claimedReppo|claimableReppo|earnedReppo" web/src/api.ts` (expected: all three present).

- [ ] **Step 2: Create the component**

Create `web/src/components/EmissionsSummary.tsx`:

```tsx
import type { Pnl } from '../api'
import { fmt } from '../lib/format'

/** Prominent Overview panel: the node's emissions at a glance — all-time claimed +
 *  currently claimable REPPO. Both come straight from /api/pnl (claimedReppo = sum of
 *  executed on-chain claims; claimableReppo = live emissions-due total). Earned = sum. */
export function EmissionsSummary({ pnl }: { pnl: Pnl | null }) {
  if (!pnl) return null
  return (
    <div className="panel-box">
      <div className="cards">
        <div className="card hero">
          <div className="k">Claimed (all-time)</div>
          <div className="v">{fmt(pnl.claimedReppo)} REPPO</div>
        </div>
        <div className="card hero">
          <div className="k">Claimable now</div>
          <div className="v"><span className={pnl.claimableReppo > 0 ? 'pos' : ''}>{fmt(pnl.claimableReppo)} REPPO</span></div>
        </div>
      </div>
      <div className="muted" style={{ marginTop: '0.5rem' }}>
        Earned total: {fmt(pnl.earnedReppo)} REPPO · claims run automatically each cycle
      </div>
    </div>
  )
}
```

If Step 1 found that `muted` is NOT a real class in `styles.css`, replace `className="muted"` with `style={{ marginTop: '0.5rem', opacity: 0.7, fontSize: '0.85em' }}` (and drop the className). Keep everything else identical.

- [ ] **Step 3: Typecheck**

Run: `npm --prefix web run typecheck`
Expected: clean (the component compiles; `fmt` + `Pnl` import resolve).

- [ ] **Step 4: Commit**

```bash
git add web/src/components/EmissionsSummary.tsx
git commit -m "feat(web): EmissionsSummary panel (claimed + claimable REPPO)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Render the panel at the top of the Overview tab

**Files:**
- Modify: `web/src/App.tsx` (import + the `tab === 'overview'` block, ~lines 67-80)

- [ ] **Step 1: Add the import**

In `web/src/App.tsx`, add alongside the other component imports (next to the `PnlCards` import):

```tsx
import { EmissionsSummary } from './components/EmissionsSummary'
```

(Match the existing import style/path in the file — the other components import from `./components/<Name>`.)

- [ ] **Step 2: Render it at the top of the Overview content**

In the `tab === 'overview'` block, insert the panel + its section header immediately AFTER the `earn-banner` div and BEFORE `<PnlCards .../>`. The current block is:

```tsx
            <div className="earn-banner">
              ...
            </div>
            <PnlCards pnl={data?.pnl ?? null} snapshot={snap} />
```

Change to:

```tsx
            <div className="earn-banner">
              ...
            </div>
            <SecHead title="Emissions" />
            <EmissionsSummary pnl={data?.pnl ?? null} />
            <PnlCards pnl={data?.pnl ?? null} snapshot={snap} />
```

(Leave the `earn-banner` contents unchanged. `SecHead` is already imported/used in this file for "Budget burn" / "Claimable emissions".)

- [ ] **Step 3: Typecheck + build**

Run: `npm --prefix web run typecheck && npm --prefix web run build`
Expected: clean; build succeeds. The Overview now renders the Emissions panel above the PnL cards.

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat(web): render EmissionsSummary at the top of Overview

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Remove the now-duplicated rows from `PnlCards`

**Files:**
- Modify: `web/src/components/PnlCards.tsx:8-10` (the `Earned`, `Claimed`, `Claimable` rows)

- [ ] **Step 1: Drop the three emission rows**

In `web/src/components/PnlCards.tsx`, the `cards` array currently is:

```tsx
  const cards: [string, ReactNode, boolean?][] = [
    ['Net REPPO', pnl ? <span className={sign(pnl.netReppo)}>{fmt(pnl.netReppo)}</span> : '—', true],
    ['Earned', pnl ? fmt(pnl.earnedReppo) : '—'],
    ['Claimed', pnl ? fmt(pnl.claimedReppo) : '—'],
    ['Claimable', pnl ? <span className={pnl.claimableReppo > 0 ? 'pos' : ''}>{fmt(pnl.claimableReppo)}</span> : '—'],
    ['Spent (mint)', pnl ? fmt(pnl.spentReppo) : '—'],
    ['Gas (ETH)', pnl ? fmt(pnl.gasSpentEth) : '—'],
    ['REPPO balance', snapshot ? fmt(snapshot.balance.reppo) : '—'],
    ['veREPPO', snapshot ? fmt(snapshot.balance.veReppo) : '—'],
    ['Epoch', snapshot ? epochLabel(snapshot.epoch) : '—'],
  ]
```

Remove the `Earned`, `Claimed`, and `Claimable` rows so it becomes:

```tsx
  const cards: [string, ReactNode, boolean?][] = [
    ['Net REPPO', pnl ? <span className={sign(pnl.netReppo)}>{fmt(pnl.netReppo)}</span> : '—', true],
    ['Spent (mint)', pnl ? fmt(pnl.spentReppo) : '—'],
    ['Gas (ETH)', pnl ? fmt(pnl.gasSpentEth) : '—'],
    ['REPPO balance', snapshot ? fmt(snapshot.balance.reppo) : '—'],
    ['veREPPO', snapshot ? fmt(snapshot.balance.veReppo) : '—'],
    ['Epoch', snapshot ? epochLabel(snapshot.epoch) : '—'],
  ]
```

(`Net REPPO` stays — it's the headline P&L figure, not an emissions total. The `pnl` prop is still used by `Net REPPO`/`Spent`/`Gas`, so no prop or import changes.)

- [ ] **Step 2: Typecheck + build**

Run: `npm --prefix web run typecheck && npm --prefix web run build`
Expected: clean; build succeeds. No unused-import error (`fmt`, `sign`, `epochLabel`, `ReactNode` all still used).

- [ ] **Step 3: Commit**

```bash
git add web/src/components/PnlCards.tsx
git commit -m "feat(web): drop claimed/claimable/earned from PnlCards (now in EmissionsSummary)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full gate

- [ ] **Step 1: Web typecheck + build**

Run: `npm --prefix web run typecheck && npm --prefix web run build`
Expected: both clean.

- [ ] **Step 2: Root build (the dashboard SPA ships inside the backend build)**

Run: `npm run build`
Expected: backend `tsc` + the web SPA build both succeed (the root build also builds `web/`).

- [ ] **Step 3: Backend test suite unaffected (sanity)**

Run: `npm test`
Expected: full suite green (this is a web-only change; backend tests should be untouched).

- [ ] **Step 4: Manual check (optional)**

Rebuild + redeploy the container (`docker build -t orquestra:latest .` then recreate) and open the Overview: the Emissions panel shows at the top with Claimed (all-time) + Claimable now; the three rows are gone from the PnL cards; a node with no matured claims shows Claimed `0 REPPO` (correct).

---

## Self-Review

- **Spec coverage:** §Design "EmissionsSummary component" → Task 1. §"App.tsx (Overview)" render at top → Task 2. §"PnlCards de-dupe" → Task 3. §Testing (web typecheck + build) → Tasks 1-4. §"No backend change" → honored (no `src/` or `api.ts` edit; `Pnl` fields reused). Zero-state (`0 REPPO`) → handled by `fmt(0)` and the `if (!pnl) return null` guard. ✓
- **Placeholder scan:** none — full component code; exact array edits shown for PnlCards; every run step has a concrete command + expected result. The one conditional (the `muted` class) names the exact fallback (inline style) rather than leaving it open. ✓
- **Type consistency:** `EmissionsSummary({ pnl }: { pnl: Pnl | null })` — same `Pnl` type and `pnl`-nullable shape `PnlCards`/`App` already use; rendered with `pnl={data?.pnl ?? null}` exactly like `PnlCards` in App. `fmt` imported from `../lib/format` (same as PnlCards). Fields `claimedReppo`/`claimableReppo`/`earnedReppo` match `web/src/api.ts`. ✓
