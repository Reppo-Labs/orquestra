# HL Adapter Data-Sourcing Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Hyperliquid adapter source complete, high-signal trade datasets — capture whole round-trips via an epoch-aligned window, rank wallets on realized in-window PnL, and gate on round-trip quality — so minted pods can actually clear datanet 9's rubric.

**Architecture:** Keep the HL leaderboard as a cheap *candidate pool*; for each candidate, fetch a wider epoch-aligned fills window, reconstruct round-trips (already built in `dataset.ts`), summarize wallet quality, **rank by realized PnL**, and emit only wallets passing a round-trip quality gate. All new logic is pure + dependency-injected (epoch provider, clock, fetchers) so it is unit-testable with no network.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, the existing `reppo`/HL fetch layer. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-06-orquestra-hl-adapter-redesign-design.md`
**Builds on:** PR #2 (`fix/hl-adapter-mint-path`) — `aggregateRoundTrips`/`RoundTrip` with `entry_px`/`exit_px`.

---

## File structure

- Create: `src/adapter/hyperliquid/window.ts` — `fillsWindow(epoch, openLookbackDays, nowMs)` → `{startTime,endTime}` (ms).
- Create: `src/adapter/hyperliquid/window.test.ts`
- Create: `src/adapter/hyperliquid/quality.ts` — `walletQuality(trips)` + `passesQualityGate(q, params)`.
- Create: `src/adapter/hyperliquid/quality.test.ts`
- Modify: `src/adapter/hyperliquid/index.ts` — `HlParams` + defaults; factory takes injectable `epochProvider`, `now`, `params`; reworked `discover()`; windowed `fetchFills`.
- Modify: `src/adapter/hyperliquid/index.test.ts` — cover the new discover/ranking/gating.
- Create: `docs/runbooks/hl-mint-earn-test.md` — the live earn-test (spec section D).

> **Note on params:** the templates spec's `adapterParams` plumbing is NOT built yet. This plan passes params via the factory (`createHyperliquidAdapter(deps)`) with defaults — decoupled from the unbuilt template system. Wiring to `adapterParams` is a later task in the templates plan.

> **Note on canonicalKey:** unchanged from PR #2 (wallet + closed-fill span + count). Epoch-deterministic keys are the dedup spec's concern, not this plan.

---

### Task 1: Epoch-aligned fills window (pure)

**Files:**
- Create: `src/adapter/hyperliquid/window.ts`
- Test: `src/adapter/hyperliquid/window.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/adapter/hyperliquid/window.test.ts
import { describe, it, expect } from 'vitest'
import { fillsWindow } from './window.js'

// epochStart/epochDurationSeconds are UNIX SECONDS (from `reppo query epoch`).
const epoch = { epochStart: 1_780_000_000, epochDurationSeconds: 172_800 }
const NOW_MS = 1_780_100_000_000 // some time during/after the epoch, in ms

describe('fillsWindow', () => {
  it('starts openLookbackDays before the epoch start (ms) so opens are captured', () => {
    const w = fillsWindow(epoch, 30, NOW_MS)
    expect(w.startTime).toBe((1_780_000_000 - 30 * 86_400) * 1000)
  })

  it('ends at now (ms) when now is after epoch start', () => {
    expect(fillsWindow(epoch, 30, NOW_MS).endTime).toBe(NOW_MS)
  })

  it('never returns a negative startTime', () => {
    expect(fillsWindow({ epochStart: 10, epochDurationSeconds: 100 }, 365, NOW_MS).startTime).toBe(0)
  })

  it('endTime is never before the epoch start (clock skew guard)', () => {
    const earlyNow = (1_780_000_000 - 1000) * 1000
    expect(fillsWindow(epoch, 30, earlyNow).endTime).toBe(1_780_000_000 * 1000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapter/hyperliquid/window.test.ts`
Expected: FAIL — `Cannot find module './window.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/adapter/hyperliquid/window.ts

/** A fills fetch window in UNIX MILLISECONDS (HL userFillsByTime uses ms). */
export interface FillsWindow { startTime: number; endTime: number }

/** Compute an epoch-aligned fills window.
 *
 *  HL's rolling "last 7 days" window truncated positions (we saw closes but not
 *  their opens → entry_px null). Anchoring to the datanet's validity epoch and
 *  reaching back `openLookbackDays` before it captures whole round-trips, and is
 *  deterministic across operators (the dedup spec relies on the same alignment).
 *
 *  `epoch` fields are UNIX SECONDS (from `reppo query epoch`); the window is ms. */
export function fillsWindow(
  epoch: { epochStart: number; epochDurationSeconds: number },
  openLookbackDays: number,
  nowMs: number,
): FillsWindow {
  const startSec = epoch.epochStart - openLookbackDays * 86_400
  const startTime = Math.max(0, startSec * 1000)
  const endTime = Math.max(nowMs, epoch.epochStart * 1000)
  return { startTime, endTime }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapter/hyperliquid/window.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapter/hyperliquid/window.ts src/adapter/hyperliquid/window.test.ts
git commit -m "feat(hl): epoch-aligned fills window (capture whole round-trips)"
```

---

### Task 2: Wallet quality summary + gate (pure)

**Files:**
- Create: `src/adapter/hyperliquid/quality.ts`
- Test: `src/adapter/hyperliquid/quality.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/adapter/hyperliquid/quality.test.ts
import { describe, it, expect } from 'vitest'
import { walletQuality, passesQualityGate, type QualityParams } from './quality.js'
import type { RoundTrip } from './dataset.js'

const trip = (o: Partial<RoundTrip> = {}): RoundTrip => ({
  market: 'BTC', direction: 'long', pnl: 100, win: true, n_fills: 2,
  size: 1, entry_px: 100, exit_px: 110, first_ms: 1, last_ms: 2, tx_hashes: ['0x1'], ...o,
})
const params: QualityParams = { minRoundTrips: 3, minMarkets: 2, minRealizedPnl: 0 }

describe('walletQuality', () => {
  it('summarizes realized PnL, complete trips, markets, win rate', () => {
    const q = walletQuality([
      trip({ market: 'BTC', pnl: 100 }),
      trip({ market: 'ETH', pnl: -40 }),
      trip({ market: 'SOL', pnl: 60, entry_px: null }), // incomplete (no captured open)
    ])
    expect(q.realizedPnl).toBeCloseTo(120)
    expect(q.nTrips).toBe(3)
    expect(q.nCompleteTrips).toBe(2)   // SOL had entry_px null
    expect(q.nMarkets).toBe(3)
    expect(q.winRate).toBeCloseTo(66.67)
  })
})

describe('passesQualityGate', () => {
  it('passes a wallet with enough complete trips, markets, and positive PnL', () => {
    const trips = [
      trip({ market: 'BTC' }), trip({ market: 'ETH' }), trip({ market: 'SOL' }),
    ]
    expect(passesQualityGate(walletQuality(trips), params)).toBe(true)
  })

  it('rejects when too few COMPLETE round-trips (entry_px present)', () => {
    const trips = [trip({ entry_px: null }), trip({ entry_px: null }), trip({ entry_px: null })]
    expect(passesQualityGate(walletQuality(trips), params)).toBe(false)
  })

  it('rejects a single-market wallet (one lucky position)', () => {
    const trips = [trip({ market: 'BTC' }), trip({ market: 'BTC' }), trip({ market: 'BTC' })]
    expect(passesQualityGate(walletQuality(trips), params)).toBe(false)
  })

  it('rejects net-negative realized PnL', () => {
    const trips = [trip({ market: 'BTC', pnl: -100 }), trip({ market: 'ETH', pnl: 10 }), trip({ market: 'SOL', pnl: 10 })]
    expect(passesQualityGate(walletQuality(trips), params)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapter/hyperliquid/quality.test.ts`
Expected: FAIL — `Cannot find module './quality.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/adapter/hyperliquid/quality.ts
import type { RoundTrip } from './dataset.js'

export interface WalletQuality {
  realizedPnl: number
  nTrips: number
  /** round-trips whose open was captured in-window (entry_px present). */
  nCompleteTrips: number
  nMarkets: number
  winRate: number
}

export interface QualityParams {
  /** minimum COMPLETE round-trips (entry_px present) — rubric wants entry+sizing+exit. */
  minRoundTrips: number
  /** minimum distinct markets — guard against one lucky position. */
  minMarkets: number
  /** minimum realized PnL over the window. */
  minRealizedPnl: number
}

/** Summarize a wallet's reconstructed round-trips. Pure. */
export function walletQuality(trips: RoundTrip[]): WalletQuality {
  const realizedPnl = trips.reduce((a, t) => a + t.pnl, 0)
  const nCompleteTrips = trips.filter((t) => t.entry_px != null).length
  const nMarkets = new Set(trips.map((t) => t.market)).size
  const wins = trips.filter((t) => t.pnl > 0).length
  return {
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    nTrips: trips.length,
    nCompleteTrips,
    nMarkets,
    winRate: trips.length ? Math.round((wins / trips.length) * 10000) / 100 : 0,
  }
}

/** Rubric-aligned selection gate. Pure. */
export function passesQualityGate(q: WalletQuality, p: QualityParams): boolean {
  return q.nCompleteTrips >= p.minRoundTrips && q.nMarkets >= p.minMarkets && q.realizedPnl >= p.minRealizedPnl
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapter/hyperliquid/quality.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapter/hyperliquid/quality.ts src/adapter/hyperliquid/quality.test.ts
git commit -m "feat(hl): wallet round-trip quality summary + selection gate"
```

---

### Task 3: HL params, DI surface, and windowed fetchFills signature

**Files:**
- Modify: `src/adapter/hyperliquid/index.ts` (top section: imports, types, defaults, `HlFetchers`, `defaultFetchers`)

- [ ] **Step 1: Replace the constants + `HlFetchers` interface + `defaultFetchers`**

Open `src/adapter/hyperliquid/index.ts`. Replace the import block and the `HlFetchers`/`WINDOW`/`MIN_VLM`/`defaultFetchers` section (currently lines ~1–32) with:

```ts
// src/adapter/hyperliquid/index.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rankByMargin } from './rank.js'
import { buildHlDataset, aggregateRoundTrips } from './dataset.js'
import { fillsWindow, type FillsWindow } from './window.js'
import { walletQuality, passesQualityGate, type QualityParams } from './quality.js'
import { queryEpochJson } from '../../reppo/queryEpoch.js'
import type { DatanetAdapter, CandidatePod, AdapterContext } from '../types.js'

const execFileAsync = promisify(execFile)

/** Leaderboard ranking window (HL's own metric) — used only to pre-filter a
 *  candidate pool; selection is by realized in-window PnL (see discover). */
const LEADERBOARD_WINDOW = 'week'

export interface HlParams extends QualityParams {
  /** how many ranked leaderboard wallets to consider as the candidate pool. */
  poolSize: number
  /** leaderboard volume floor (liquidity pre-filter). */
  minVlm: number
  /** days before the epoch start to reach back so opens are captured. */
  openLookbackDays: number
}

export const HL_DEFAULTS: HlParams = {
  poolSize: 20,
  minVlm: 100_000,
  openLookbackDays: 45,
  minRoundTrips: 3,
  minMarkets: 2,
  minRealizedPnl: 0,
}

export interface HlFetchers {
  fetchLeaderboard(): Promise<unknown>
  /** fetch a wallet's fills bounded to [window.startTime, window.endTime] (ms). */
  fetchFills(wallet: string, window: FillsWindow): Promise<unknown>
}

export interface HlDeps {
  fetchers?: HlFetchers
  params?: Partial<HlParams>
  /** current on-chain epoch (default: reppo CLI). Injected in tests. */
  epochProvider?: () => Promise<{ epochStart: number; epochDurationSeconds: number }>
  /** clock (default: Date.now). Injected in tests. */
  now?: () => number
}

/** Default fetchers hit the HL public API (no auth) via curl. fetchFills pages
 *  forward over the window (HL caps ~2000 fills/response) until exhausted. */
const defaultFetchers: HlFetchers = {
  async fetchLeaderboard() {
    const { stdout } = await execFileAsync('curl', ['-fsS', '--max-time', '60', 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'], { maxBuffer: 64 * 1024 * 1024 })
    return JSON.parse(stdout)
  },
  async fetchFills(wallet: string, window: FillsWindow) {
    const all: unknown[] = []
    let cursor = window.startTime
    // HL returns oldest→newest within [startTime,endTime], capped per call. Advance
    // the cursor past the last returned fill until we reach endTime or a short page.
    for (let page = 0; page < 50; page++) {
      const body = JSON.stringify({ type: 'userFillsByTime', user: wallet, startTime: cursor, endTime: window.endTime, aggregateByTime: false })
      const { stdout } = await execFileAsync('curl', ['-fsS', '--max-time', '60', '-H', 'Content-Type: application/json', '-d', body, 'https://api.hyperliquid.xyz/info'], { maxBuffer: 64 * 1024 * 1024 })
      const batch = JSON.parse(stdout) as Array<{ time: number }>
      if (!Array.isArray(batch) || batch.length === 0) break
      all.push(...batch)
      const lastT = batch[batch.length - 1]!.time
      if (batch.length < 2000 || lastT <= cursor) break // exhausted / no progress
      cursor = lastT + 1
    }
    return all
  },
}
```

- [ ] **Step 2: Verify the new top section is consistent (factory is rewritten in Task 4)**

Run: `npm run typecheck`
Expected: errors ONLY in the not-yet-updated `createHyperliquidAdapter` (Task 4) and `index.test.ts` (Task 5). Do not fix here.

- [ ] **Step 3: Commit (WIP — compiles after Task 4)**

```bash
git add src/adapter/hyperliquid/index.ts
git commit -m "feat(hl): params, DI (epoch/clock), windowed+paginated fetchFills [wip]"
```

---

### Task 4: Rework `discover()` — candidate pool → round-trips → realized-PnL rank → quality gate

**Files:**
- Modify: `src/adapter/hyperliquid/index.ts` (the `createHyperliquidAdapter` factory)

- [ ] **Step 1: Replace `createHyperliquidAdapter` with the new version**

Replace the entire existing `createHyperliquidAdapter(...)` function with:

```ts
/** Reference adapter: HL leaderboard (candidate pool) → epoch-aligned fills per
 *  wallet → reconstructed round-trips → rank by realized in-window PnL → quality
 *  gate → labeled datasets. */
export function createHyperliquidAdapter(deps: HlDeps = {}): DatanetAdapter {
  const fetchers = deps.fetchers ?? defaultFetchers
  const params: HlParams = { ...HL_DEFAULTS, ...deps.params }
  const epochProvider = deps.epochProvider ?? (async () => {
    const e = await queryEpochJson()
    return { epochStart: e.epochStart, epochDurationSeconds: e.epochDurationSeconds }
  })
  const now = deps.now ?? (() => Date.now())

  return {
    id: 'hyperliquid',
    async discover(ctx: AdapterContext): Promise<CandidatePod[]> {
      const epoch = await epochProvider()
      const window = fillsWindow(epoch, params.openLookbackDays, now())

      const lb = await fetchers.fetchLeaderboard()
      const pool = rankByMargin(lb, LEADERBOARD_WINDOW, params.poolSize, params.minVlm)

      const scored: Array<{ cand: CandidatePod; realizedPnl: number }> = []
      for (const wallet of pool) {
        try {
          const fills = await fetchers.fetchFills(wallet, window)
          const trips = aggregateRoundTrips(fills as Parameters<typeof aggregateRoundTrips>[0])
          const q = walletQuality(trips)
          if (!passesQualityGate(q, params)) continue
          const cand = buildHlDataset(wallet, fills, ctx.datanetId)
          if (cand) scored.push({ cand, realizedPnl: q.realizedPnl })
        } catch (err) {
          console.warn(`[hl-adapter] wallet ${wallet} skipped:`, err instanceof Error ? err.message : String(err))
        }
      }

      // Select by realized in-window PnL (NOT the leaderboard metric) — fixes the
      // rank/label contradiction where a top-ranked wallet showed in-window losses.
      scored.sort((a, b) => b.realizedPnl - a.realizedPnl)
      return scored.slice(0, ctx.topN).map((s) => s.cand)
    },
  }
}
```

Note: the `matches` method was removed in the PR #2 era; `discover` is the only method. If `matches` is still present in your tree, delete it.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: errors ONLY in `index.test.ts` (Task 5). `index.ts` itself compiles.

- [ ] **Step 3: Commit**

```bash
git add src/adapter/hyperliquid/index.ts
git commit -m "feat(hl): discover ranks by realized in-window PnL + round-trip quality gate"
```

---

### Task 5: Update the adapter integration test

**Files:**
- Modify: `src/adapter/hyperliquid/index.test.ts`

- [ ] **Step 1: Replace the test file**

```ts
// src/adapter/hyperliquid/index.test.ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHyperliquidAdapter } from './index.js'
import type { FillsWindow } from './window.js'
import type { DatanetRubric } from '../../rubric/types.js'

const lb = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/hl-leaderboard.json'), 'utf-8'))
const fills = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/hl-fills.json'), 'utf-8'))
const rubric = { datanetId: '9', name: 'TradingGym AI', canMint: true } as DatanetRubric

// Deterministic epoch + clock so the window is fixed in tests (no network, no Date.now).
const epochProvider = async () => ({ epochStart: 1_700_000_000, epochDurationSeconds: 172_800 })
const now = () => 1_700_100_000_000

describe('hyperliquidAdapter', () => {
  it('has id "hyperliquid"', () => {
    expect(createHyperliquidAdapter({ fetchers: { fetchLeaderboard: async () => lb, fetchFills: async () => fills } }).id).toBe('hyperliquid')
  })

  it('passes the computed window to fetchFills (epoch-aligned, not now-7d)', async () => {
    const fetchFills = vi.fn(async (_w: string, _win: FillsWindow) => fills)
    const a = createHyperliquidAdapter({
      fetchers: { fetchLeaderboard: async () => lb, fetchFills },
      epochProvider, now, params: { minRealizedPnl: -1e12, minRoundTrips: 1, minMarkets: 1 },
    })
    await a.discover({ datanetId: '9', rubric, topN: 2 })
    expect(fetchFills).toHaveBeenCalled()
    const win = fetchFills.mock.calls[0][1]
    expect(win.startTime).toBe((1_700_000_000 - 45 * 86_400) * 1000) // default openLookbackDays
    expect(win.endTime).toBe(1_700_100_000_000)
  })

  it('gates out low-quality wallets (default gate rejects the thin fixture)', async () => {
    // The fixture is one wallet of truncated close-only fills (entry_px null) → 0 complete trips.
    const a = createHyperliquidAdapter({
      fetchers: { fetchLeaderboard: async () => lb, fetchFills: async () => fills },
      epochProvider, now, // default params: minRoundTrips 3, minMarkets 2
    })
    const cands = await a.discover({ datanetId: '9', rubric, topN: 5 })
    expect(cands).toEqual([])
  })

  it('emits candidates and ranks them by realized PnL when the gate is permissive', async () => {
    // Two wallets: one clearly more profitable. Permissive gate so both pass; assert order.
    const winner = [
      { coin: 'BTC', dir: 'Open Long', side: 'B', sz: '1', px: '100', closedPnl: '0', time: 1, hash: '0xa' },
      { coin: 'BTC', dir: 'Close Long', side: 'A', sz: '1', px: '200', closedPnl: '900', time: 2, hash: '0xb' },
      { coin: 'ETH', dir: 'Open Long', side: 'B', sz: '1', px: '10', closedPnl: '0', time: 3, hash: '0xc' },
      { coin: 'ETH', dir: 'Close Long', side: 'A', sz: '1', px: '11', closedPnl: '100', time: 4, hash: '0xd' },
    ]
    const loser = [
      { coin: 'BTC', dir: 'Open Long', side: 'B', sz: '1', px: '100', closedPnl: '0', time: 1, hash: '0xe' },
      { coin: 'BTC', dir: 'Close Long', side: 'A', sz: '1', px: '90', closedPnl: '10', time: 2, hash: '0xf' },
      { coin: 'ETH', dir: 'Open Long', side: 'B', sz: '1', px: '10', closedPnl: '0', time: 3, hash: '0x1' },
      { coin: 'ETH', dir: 'Close Long', side: 'A', sz: '1', px: '11', closedPnl: '5', time: 4, hash: '0x2' },
    ]
    const byWallet: Record<string, unknown> = { '0xAAA': winner, '0xBBB': loser }
    const a = createHyperliquidAdapter({
      fetchers: { fetchLeaderboard: async () => lb, fetchFills: async (w) => byWallet[w] ?? [] },
      epochProvider, now,
      params: { minRoundTrips: 2, minMarkets: 2, minRealizedPnl: 0, minVlm: 100_000, poolSize: 12 },
    })
    const cands = await a.discover({ datanetId: '9', rubric, topN: 5 })
    expect(cands.length).toBe(2)
    expect(cands[0].podName).toContain('0xAAA'.slice(0, 6)) // winner (higher realized PnL) ranked first
  })

  it('isolates a wallet whose fetchFills throws (others still considered)', async () => {
    let n = 0
    const a = createHyperliquidAdapter({
      fetchers: {
        fetchLeaderboard: async () => lb,
        fetchFills: async () => { if (++n === 1) throw new Error('rpc'); return fills },
      },
      epochProvider, now, params: { minRoundTrips: 1, minMarkets: 1, minRealizedPnl: -1e12 },
    })
    const cands = await a.discover({ datanetId: '9', rubric, topN: 5 })
    expect(Array.isArray(cands)).toBe(true) // did not throw
  })
})
```

- [ ] **Step 2: Run the adapter tests**

Run: `npx vitest run src/adapter/hyperliquid/index.test.ts`
Expected: PASS (5 tests). The leaderboard fixture's top two ranked addresses are `0xAAA`,`0xBBB` (see `rank.test.ts`); the `byWallet` map supplies fills for those, and any other ranked wallet returns `[]` → gated out.

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/adapter/hyperliquid/index.test.ts
git commit -m "test(hl): cover epoch window, realized-PnL ranking, quality gate"
```

---

### Task 6: Live validation against real HL (manual, no commit)

**Files:** none (operational verification, mirrors how the bug was diagnosed).

- [ ] **Step 1: Build + run discover against live HL in the container**

```bash
npm run build
CID=$(docker ps --filter ancestor=orquestra:fixed --format '{{.ID}}' | head -1)   # or the current image tag
docker cp dist/. "$CID:/app/dist/"
docker exec -w /app "$CID" node --input-type=module -e '
import { createHyperliquidAdapter } from "/app/dist/adapter/hyperliquid/index.js"
import { getDatanetRubric } from "/app/dist/rubric/load.js"
const rubric = await getDatanetRubric("9")
const a = createHyperliquidAdapter()
const cands = await a.discover({ datanetId: "9", rubric, topN: 5 })
console.log("candidates:", cands.length)
for (const c of cands) {
  const m = c.dataset.aggregate_metrics
  console.log(`  ${c.podName} | n_trades=${m.n_trades} win_rate=${m.win_rate}% sum_pnl=${m.sum_pnl} entry_px(first)=${c.dataset.trades[0]?.entry_px}`)
}
'
```

- [ ] **Step 2: Confirm the redesign produced complete, ranked candidates**

Expected: candidates now have `entry_px` populated on most trips (window captured opens), plausible win rates, and are ordered by realized PnL. Record the count + a sample. If still 0, raise `openLookbackDays` (param) and record HL lookback limits in the runbook (Task 7) — do NOT loosen the quality gate just to force mints.

---

### Task 7: Live earn-test runbook (spec section D)

**Files:**
- Create: `docs/runbooks/hl-mint-earn-test.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Runbook: HL mint earn-test (does a minted pod actually earn?)

**Why:** G1 showed minting on datanet 9 has never produced measurable emissions.
Before expanding minting (templates), prove a *good* pod earns.

## Procedure
1. Deploy the redesigned adapter (this plan) to the live node (rebuild image, redeploy).
2. Keep budget caps small (current: mintReppoMax 50, mintGasEthMax 0.01) — exposure is bounded.
3. Let the node run; confirm it mints a handful of pods on datanet 9 (dashboard Activity → kind=mint, status=executed). If it mints 0, the quality gate is rejecting everything → revisit params / data sourcing, do NOT loosen the gate just to mint.
4. Over the next 1–2 epochs, watch the dashboard:
   - Do our minted pods accrue **upVotes** (curators valuing the data)?
   - Does **emissions-due** / **claimed** become non-zero for our pods? (claim phase runs each cycle.)
5. Record per-pod: epoch, upVotes/downVotes, REPPO earned, gas spent.

## Decision gate
- **Earns net-positive** (emissions > mint+gas cost over the horizon) → proceed to the
  template-expansion program (more datanets).
- **Earns ~0 / net-negative** → minting stays off / voting-only; revisit data sourcing
  or conclude this datanet isn't worth minting on.

## Notes
- HL `userFillsByTime` lookback/pagination limits observed: <record during Task 6>.
- This measures market demand (do curators want the data), which code quality cannot.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/hl-mint-earn-test.md
git commit -m "docs(hl): live mint earn-test runbook (G1 decision gate)"
```

---

## Self-review checklist (completed)

- **Spec coverage:** A (epoch window) → Task 1; B (realized-PnL ranking) → Task 4; C (round-trip quality gate) → Task 2 + Task 4; D (earn-test) → Task 7; params → Task 3. ✓
- **Placeholders:** none — every code step has full code; the only `<record during Task 6>` is an intentional runbook field filled during live validation. ✓
- **Type consistency:** `FillsWindow` (Task 1) used in `HlFetchers.fetchFills` + tests (Tasks 3/5); `QualityParams` (Task 2) extended by `HlParams` (Task 3), consumed by `passesQualityGate` (Tasks 2/4); `RoundTrip.entry_px` (PR #2) drives `nCompleteTrips`. ✓
- **Decomposition:** pure units (window, quality) isolated from the I/O factory; each task independently testable. ✓
