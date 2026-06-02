# Orquestra — Phase 1, Plan 5: Adapter interface + Minter + Hyperliquid adapter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the pluggable `DatanetAdapter` interface, a generic `selectMints` decision step (dedup + score candidates vs the datanet's publisher spec → mint intents), and the reference **Hyperliquid adapter** that turns the HL leaderboard + fills into labeled dataset candidates.

**Architecture:** `selectMints` is pure decision logic (injected candidate scorer + a seen-keys dedup set + a dataset writer) — fully unit-tested. The Hyperliquid adapter's two heavy pure pieces — **margin ranking** (`rankByMargin`) and **dataset building** (`buildHlDataset`) — are unit-tested against fixtures; the HL HTTP calls are an **injected fetcher** so `discover()` is testable without the network. This is the reference impl proving the adapter interface, not a special case.

**Tech Stack:** TypeScript, zod, vitest. Reuses `MintIntent` (Plan 3), `DatanetRubric` (Plan 2). HL public API shapes ported from the aeon dashboard's `buildDataset`.

**Builds on:** Plans 1–4. The minter only **produces** `MintIntent[]`; the Plan 3 `WalletExecutor` executes them. The `CandidateScorer` default is an LLM (scoring vs `publisherSpec`); injected here.

---

## File structure (this plan)

- Create: `src/adapter/types.ts` — `DatanetAdapter`, `AdapterContext`, `CandidatePod`, `CandidateScorer`.
- Create: `src/minter/select.ts` — `selectMints(...)` (dedup + score → MintIntent, writes dataset bodies).
- Create: `src/adapter/hyperliquid/rank.ts` — `rankByMargin(leaderboard, window, topN, minVlm)`.
- Create: `src/adapter/hyperliquid/dataset.ts` — `buildHlDataset(wallet, fills)` → candidate or null (≥20-closed floor).
- Create: `src/adapter/hyperliquid/index.ts` — `hyperliquidAdapter` (`discover` via injected fetchers).
- Create: `test/fixtures/hl-leaderboard.json`, `test/fixtures/hl-fills.json`.
- Test: `src/minter/select.test.ts`, `src/adapter/hyperliquid/rank.test.ts`, `src/adapter/hyperliquid/dataset.test.ts`, `src/adapter/hyperliquid/index.test.ts`.

---

### Task 1: Adapter + candidate types

**Files:**
- Create: `src/adapter/types.ts`

- [ ] **Step 1: Write the implementation** (types only)

```ts
// src/adapter/types.ts
import type { DatanetRubric } from '../rubric/types.js'

/** A mint candidate an adapter produced for a datanet. */
export interface CandidatePod {
  /** stable dedup key (e.g. sha256-derived). */
  canonicalKey: string
  podName: string
  podDescription: string
  /** labeled dataset body the CLI pins + mints. */
  dataset: unknown
  /** adapter's own 1-10 quality estimate, if any. */
  selfScore?: number
}

export interface AdapterContext {
  datanetId: string
  rubric: DatanetRubric
  /** how many top wallets / items to pull (adapter-specific budget). */
  topN: number
}

/** A pluggable per-datanet data source. The reference impl is `hyperliquid`. */
export interface DatanetAdapter {
  id: string
  /** does this adapter serve the given datanet? (by id mapping or domain) */
  matches(datanetId: string, rubric: DatanetRubric): boolean
  /** source + label domain data into mint candidates. */
  discover(ctx: AdapterContext): Promise<CandidatePod[]>
}

/** Scores a candidate 1-10 against the datanet's publisher spec. LLM by default. */
export interface CandidateScorer {
  scoreCandidate(candidate: CandidatePod, rubric: DatanetRubric): Promise<{ score: number; reason: string }>
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapter/types.ts
git commit -m "feat(adapter): DatanetAdapter interface + CandidatePod/CandidateScorer types"
```

---

### Task 2: Generic Minter (selectMints)

**Files:**
- Create: `src/minter/select.ts`
- Test: `src/minter/select.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/minter/select.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectMints } from './select.js'
import type { CandidatePod, CandidateScorer } from '../adapter/types.js'
import type { DatanetRubric } from '../rubric/types.js'

const rubric: DatanetRubric = {
  datanetId: '9', name: 'TradingGym AI', goal: 'g', publisherSpec: 'HL perp data', voterRubric: 'v',
  canVote: true, canMint: true, status: 'ACTIVE',
  economics: { accessFeeReppo: 50, emissionsPerEpochReppo: 500, upVoteVolume: 1, downVoteVolume: 1, nativeTokenSymbol: 'REPPO' },
}
const cand = (key: string): CandidatePod => ({ canonicalKey: key, podName: `pod-${key}`, podDescription: 'd', dataset: { rows: [key] } })
const scorerOf = (scores: Record<string, number>): CandidateScorer => ({
  scoreCandidate: async (c) => ({ score: scores[c.canonicalKey] ?? 5, reason: `r:${c.canonicalKey}` }),
})

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-mint-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('selectMints (minScore 7)', () => {
  it('mints candidates scoring >= minScore, writes the dataset body, sets datasetPath', async () => {
    const intents = await selectMints('9', [cand('a'), cand('b')], rubric,
      { dataDir: dir, minScore: 7, seenKeys: new Set(), scorer: scorerOf({ a: 9, b: 4 }) })
    expect(intents.map((i) => i.canonicalKey)).toEqual(['a']) // b scored 4 < 7
    expect(intents[0].kind).toBe('mint'); expect(intents[0].datanetId).toBe('9')
    expect(existsSync(intents[0].datasetPath)).toBe(true)
    expect(JSON.parse(readFileSync(intents[0].datasetPath, 'utf-8'))).toEqual({ rows: ['a'] })
  })

  it('dedups candidates whose canonicalKey is already in seenKeys (no score, no mint)', async () => {
    let scored: string[] = []
    const tracking: CandidateScorer = { scoreCandidate: async (c) => { scored.push(c.canonicalKey); return { score: 9, reason: '' } } }
    const intents = await selectMints('9', [cand('dup'), cand('new')], rubric,
      { dataDir: dir, minScore: 7, seenKeys: new Set(['dup']), scorer: tracking })
    expect(scored).toEqual(['new'])
    expect(intents.map((i) => i.canonicalKey)).toEqual(['new'])
  })

  it('returns [] without scoring when the rubric is not mint-capable', async () => {
    let calls = 0
    const counting: CandidateScorer = { scoreCandidate: async () => { calls++; return { score: 9, reason: '' } } }
    const intents = await selectMints('9', [cand('a')], { ...rubric, canMint: false },
      { dataDir: dir, minScore: 7, seenKeys: new Set(), scorer: counting })
    expect(intents).toEqual([]); expect(calls).toBe(0)
  })

  it('carries the score onto selfScore and dedups within the same batch', async () => {
    const intents = await selectMints('9', [cand('a'), cand('a')], rubric,
      { dataDir: dir, minScore: 7, seenKeys: new Set(), scorer: scorerOf({ a: 8 }) })
    expect(intents).toHaveLength(1)           // second 'a' deduped within batch
    expect(intents[0].selfScore).toBe(8)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/minter/select.test.ts`
Expected: FAIL — cannot find module `./select.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/minter/select.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CandidatePod, CandidateScorer } from '../adapter/types.js'
import type { DatanetRubric } from '../rubric/types.js'
import type { MintIntent } from '../wallet/intents.js'

export interface SelectMintsOpts {
  dataDir: string
  /** mint a candidate only if its LLM score is >= this (1-10). */
  minScore: number
  /** canonical keys already minted (ledger dedup). */
  seenKeys: Set<string>
  scorer: CandidateScorer
  /** optional REPPO cost estimate per mint for the budget. */
  estReppoCost?: number
}

/** Score candidates vs the publisher spec; mint those >= minScore that aren't
 *  already seen. Writes each minted dataset body to disk and references it. */
export async function selectMints(
  datanetId: string,
  candidates: CandidatePod[],
  rubric: DatanetRubric,
  opts: SelectMintsOpts,
): Promise<MintIntent[]> {
  if (!rubric.canMint) return []
  const dataOut = join(opts.dataDir, 'pending-data')
  mkdirSync(dataOut, { recursive: true })
  const seen = new Set(opts.seenKeys)
  const intents: MintIntent[] = []

  for (const c of candidates) {
    if (seen.has(c.canonicalKey)) continue
    seen.add(c.canonicalKey) // dedup within the batch too
    const { score } = await opts.scorer.scoreCandidate(c, rubric)
    if (score < opts.minScore) continue
    const datasetPath = join(dataOut, `mint-${c.canonicalKey}.json`)
    writeFileSync(datasetPath, JSON.stringify(c.dataset))
    intents.push({
      kind: 'mint', datanetId, canonicalKey: c.canonicalKey,
      podName: c.podName, podDescription: c.podDescription, datasetPath,
      estReppoCost: opts.estReppoCost ?? 0, selfScore: score,
    })
  }
  return intents
}
```

> NOTE: `MintIntent` (Plan 3) has no `selfScore` field. **Add `selfScore?: number` to `MintIntent` in `src/wallet/intents.ts`** (the score is useful downstream for the digest), then this object typechecks with no cast.

- [ ] **Step 4: Apply the MintIntent change + run tests**

Edit `src/wallet/intents.ts`: add `selfScore?: number` to the `MintIntent` interface.

Run: `npx vitest run src/minter/select.test.ts && npx vitest run src/wallet`
Expected: minter PASS (4 tests); wallet tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/minter/select.ts src/minter/select.test.ts src/wallet/intents.ts
git commit -m "feat(minter): selectMints — dedup + score vs publisher spec → mint intents"
```

---

### Task 3: Hyperliquid margin ranking

**Files:**
- Create: `test/fixtures/hl-leaderboard.json`
- Create: `src/adapter/hyperliquid/rank.ts`
- Test: `src/adapter/hyperliquid/rank.test.ts`

- [ ] **Step 1: Create the leaderboard fixture**

```json
{
  "leaderboardRows": [
    { "ethAddress": "0xAAA", "displayName": null, "windowPerformances": [["week", { "pnl": "11400452", "roi": "1", "vlm": "331509" }]] },
    { "ethAddress": "0xBBB", "displayName": null, "windowPerformances": [["week", { "pnl": "3047441", "roi": "1", "vlm": "163210" }]] },
    { "ethAddress": "0xLOWVLM", "displayName": null, "windowPerformances": [["week", { "pnl": "500", "roi": "1", "vlm": "1000" }]] },
    { "ethAddress": "0xLOSS", "displayName": null, "windowPerformances": [["week", { "pnl": "-50000", "roi": "-1", "vlm": "500000" }]] }
  ]
}
```

- [ ] **Step 2: Write the failing test**

```ts
// src/adapter/hyperliquid/rank.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rankByMargin } from './rank.js'

const lb = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/hl-leaderboard.json'), 'utf-8'))

describe('rankByMargin', () => {
  it('ranks by pnl/vlm desc, filters vlm < minVlm and non-positive pnl, returns top N addresses', () => {
    const top = rankByMargin(lb, 'week', 2, 100000)
    expect(top).toEqual(['0xAAA', '0xBBB']) // AAA margin ~34.4 > BBB ~18.7; LOWVLM filtered (vlm<100k); LOSS filtered (pnl<0)
  })

  it('returns [] when the leaderboard is empty or malformed', () => {
    expect(rankByMargin({}, 'week', 5, 0)).toEqual([])
    expect(rankByMargin({ leaderboardRows: [] }, 'week', 5, 0)).toEqual([])
  })
})
```

- [ ] **Step 3: Write minimal implementation** (ported from aeon prefetch-hl margin ranking)

```ts
// src/adapter/hyperliquid/rank.ts
interface Row { ethAddress: string; windowPerformances?: [string, { pnl: string; vlm: string }][] }

/** Rank leaderboard wallets by margin = pnl/vlm in `window`, biasing toward
 *  directional alpha over churn. Filters vlm < minVlm and non-positive pnl. */
export function rankByMargin(raw: unknown, window: string, topN: number, minVlm: number): string[] {
  const rows = (raw as { leaderboardRows?: Row[] })?.leaderboardRows
  if (!Array.isArray(rows)) return []
  return rows
    .map((r) => {
      const w = r.windowPerformances?.find(([k]) => k === window)?.[1]
      const pnl = Number(w?.pnl ?? '0')
      const vlm = Number(w?.vlm ?? '0')
      return { addr: r.ethAddress, pnl, vlm, margin: vlm > 0 ? pnl / vlm : 0 }
    })
    .filter((x) => x.vlm >= minVlm && x.pnl > 0)
    .sort((a, b) => b.margin - a.margin)
    .slice(0, topN)
    .map((x) => x.addr)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapter/hyperliquid/rank.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/hl-leaderboard.json src/adapter/hyperliquid/rank.ts src/adapter/hyperliquid/rank.test.ts
git commit -m "feat(hl): rankByMargin — margin-rank leaderboard wallets"
```

---

### Task 4: Hyperliquid dataset builder

**Files:**
- Create: `test/fixtures/hl-fills.json`
- Create: `src/adapter/hyperliquid/dataset.ts`
- Test: `src/adapter/hyperliquid/dataset.test.ts`

- [ ] **Step 1: Create the fills fixture** (each fill: coin, px, sz, side, dir, closedPnl, time, hash; 21 closed)

```json
[
  { "coin": "BTC", "px": "60000", "sz": "0.1", "side": "B", "dir": "Close Long", "closedPnl": "120.5", "time": 1779465982424, "hash": "0xf1" },
  { "coin": "ETH", "px": "3000", "sz": "1", "side": "A", "dir": "Close Short", "closedPnl": "-40", "time": 1779465982500, "hash": "0xf2" },
  { "coin": "BTC", "px": "61000", "sz": "0.2", "side": "B", "dir": "Close Long", "closedPnl": "80", "time": 1779465982600, "hash": "0xf3" },
  { "coin": "SOL", "px": "150", "sz": "10", "side": "A", "dir": "Close Short", "closedPnl": "200", "time": 1779465982700, "hash": "0xf4" },
  { "coin": "BTC", "px": "62000", "sz": "0.1", "side": "B", "dir": "Close Long", "closedPnl": "-15", "time": 1779465982800, "hash": "0xf5" },
  { "coin": "ETH", "px": "3100", "sz": "1", "side": "B", "dir": "Close Long", "closedPnl": "55", "time": 1779465982900, "hash": "0xf6" },
  { "coin": "BTC", "px": "63000", "sz": "0.1", "side": "B", "dir": "Close Long", "closedPnl": "30", "time": 1779465983000, "hash": "0xf7" },
  { "coin": "SOL", "px": "160", "sz": "5", "side": "A", "dir": "Close Short", "closedPnl": "12", "time": 1779465983100, "hash": "0xf8" },
  { "coin": "ETH", "px": "3200", "sz": "2", "side": "A", "dir": "Close Short", "closedPnl": "-22", "time": 1779465983200, "hash": "0xf9" },
  { "coin": "BTC", "px": "64000", "sz": "0.1", "side": "B", "dir": "Close Long", "closedPnl": "44", "time": 1779465983300, "hash": "0xfa" },
  { "coin": "BTC", "px": "64500", "sz": "0.1", "side": "B", "dir": "Close Long", "closedPnl": "18", "time": 1779465983400, "hash": "0xfb" },
  { "coin": "ETH", "px": "3300", "sz": "1", "side": "B", "dir": "Close Long", "closedPnl": "9", "time": 1779465983500, "hash": "0xfc" },
  { "coin": "SOL", "px": "170", "sz": "8", "side": "A", "dir": "Close Short", "closedPnl": "61", "time": 1779465983600, "hash": "0xfd" },
  { "coin": "BTC", "px": "65000", "sz": "0.2", "side": "B", "dir": "Close Long", "closedPnl": "-5", "time": 1779465983700, "hash": "0xfe" },
  { "coin": "ETH", "px": "3400", "sz": "1", "side": "A", "dir": "Close Short", "closedPnl": "27", "time": 1779465983800, "hash": "0x10" },
  { "coin": "BTC", "px": "66000", "sz": "0.1", "side": "B", "dir": "Close Long", "closedPnl": "33", "time": 1779465983900, "hash": "0x11" },
  { "coin": "SOL", "px": "180", "sz": "4", "side": "A", "dir": "Close Short", "closedPnl": "14", "time": 1779465984000, "hash": "0x12" },
  { "coin": "ETH", "px": "3500", "sz": "1", "side": "B", "dir": "Close Long", "closedPnl": "21", "time": 1779465984100, "hash": "0x13" },
  { "coin": "BTC", "px": "67000", "sz": "0.1", "side": "B", "dir": "Close Long", "closedPnl": "40", "time": 1779465984200, "hash": "0x14" },
  { "coin": "SOL", "px": "190", "sz": "3", "side": "A", "dir": "Close Short", "closedPnl": "8", "time": 1779465984300, "hash": "0x15" },
  { "coin": "BTC", "px": "68000", "sz": "0.1", "side": "B", "dir": "Close Long", "closedPnl": "50", "time": 1779465984400, "hash": "0x16" }
]
```

- [ ] **Step 2: Write the failing test**

```ts
// src/adapter/hyperliquid/dataset.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildHlDataset } from './dataset.js'

const fills = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/hl-fills.json'), 'utf-8'))

describe('buildHlDataset', () => {
  it('builds a candidate with aggregate metrics + a canonical key from a wallet with >=20 closes', () => {
    const c = buildHlDataset('0xWALLET', fills, '9')
    expect(c).not.toBeNull()
    const ds = c!.dataset as { aggregate_metrics: { n_trades: number; win_rate: number; sum_pnl: number } }
    expect(ds.aggregate_metrics.n_trades).toBe(21)
    expect(ds.aggregate_metrics.win_rate).toBeGreaterThan(0)
    expect(c!.canonicalKey).toMatch(/^[0-9a-f]{16}$/)
    expect(c!.podName).toContain('HL perps')
  })

  it('returns null below the 20-closed-trade floor', () => {
    expect(buildHlDataset('0xWALLET', fills.slice(0, 5), '9')).toBeNull()
  })

  it('returns null for an empty / all-unclosed fill set', () => {
    expect(buildHlDataset('0xWALLET', [], '9')).toBeNull()
    expect(buildHlDataset('0xWALLET', [{ coin: 'BTC', px: '1', sz: '1', side: 'B', dir: 'Open Long', closedPnl: '0', time: 1, hash: '0x0' }], '9')).toBeNull()
  })
})
```

- [ ] **Step 3: Write minimal implementation** (ported from the aeon dashboard `buildDataset`)

```ts
// src/adapter/hyperliquid/dataset.ts
import { createHash } from 'node:crypto'
import type { CandidatePod } from '../types.js'

interface Fill { coin: string; px: string; sz: string; side: 'B' | 'A'; dir?: string; closedPnl: string; time: number; hash: string }

const MIN_CLOSED = 20

/** Build a labeled HL-perp trade dataset candidate from a wallet's fills.
 *  Returns null below the 20-closed-trade floor (too thin to evaluate). */
export function buildHlDataset(wallet: string, rawFills: unknown, datanetId: string): CandidatePod | null {
  const fills = rawFills as Fill[]
  if (!Array.isArray(fills) || fills.length === 0) return null
  const closed = fills.filter((f) => Number(f.closedPnl) !== 0)
  if (closed.length < MIN_CLOSED) return null

  const wins = closed.filter((f) => Number(f.closedPnl) > 0).length
  const sumPnl = closed.reduce((a, f) => a + Number(f.closedPnl), 0)
  let peak = 0, cum = 0, maxDd = 0
  for (const f of closed) { cum += Number(f.closedPnl); peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum) }
  const firstT = closed[0]!.time, lastT = closed[closed.length - 1]!.time
  const trades = closed.map((f) => ({
    market: f.coin.replace('xyz:', ''),
    direction: (f.dir ?? '').includes('Short') ? 'short' : 'long',
    size: Number(f.sz), fill_price: Number(f.px),
    outcome: { pnl: Math.round(Number(f.closedPnl) * 100) / 100, win: Number(f.closedPnl) > 0 },
    verification: { timestamp_ms: f.time, tx_hash: f.hash },
  }))
  const winRate = Math.round((wins / closed.length) * 10000) / 100

  const canonical = `trades:${datanetId}:${wallet}:${firstT}:${lastT}:${closed.length}`
  const canonicalKey = createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  const dataset = {
    kind: 'hl-perp-trades', schema_version: 1,
    source: { wallet, venue: 'hyperliquid-mainnet' },
    aggregate_metrics: {
      n_trades: closed.length, win_rate: winRate,
      sum_pnl: Math.round(sumPnl), max_drawdown_usd: Math.round(maxDd),
    },
    trades,
  }
  const short = `${wallet.slice(0, 6)}..${wallet.slice(-4)}`
  return {
    canonicalKey,
    podName: `HL perps, ${short}: ${closed.length} trades`,
    podDescription: `Hyperliquid perp dataset from ${short} — ${closed.length} closed trades, win_rate ${winRate}%, sum_pnl ${Math.round(sumPnl)}.`,
    dataset,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapter/hyperliquid/dataset.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/hl-fills.json src/adapter/hyperliquid/dataset.ts src/adapter/hyperliquid/dataset.test.ts
git commit -m "feat(hl): buildHlDataset — labeled perp dataset + canonical key, 20-close floor"
```

---

### Task 5: Hyperliquid adapter wiring

**Files:**
- Create: `src/adapter/hyperliquid/index.ts`
- Test: `src/adapter/hyperliquid/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/adapter/hyperliquid/index.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHyperliquidAdapter } from './index.js'
import type { DatanetRubric } from '../../rubric/types.js'

const lb = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/hl-leaderboard.json'), 'utf-8'))
const fills = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/hl-fills.json'), 'utf-8'))
const rubric = { datanetId: '9', name: 'TradingGym AI', canMint: true } as DatanetRubric

describe('hyperliquidAdapter', () => {
  it('matches datanet 9 (tradinggym) and not others', () => {
    const a = createHyperliquidAdapter({ fetchLeaderboard: async () => lb, fetchFills: async () => fills })
    expect(a.id).toBe('hyperliquid')
    expect(a.matches('9', rubric)).toBe(true)
    expect(a.matches('2', { ...rubric, datanetId: '2', name: 'Geopolitics' })).toBe(false)
  })

  it('discover() ranks wallets then builds a candidate per qualifying wallet', async () => {
    const a = createHyperliquidAdapter({ fetchLeaderboard: async () => lb, fetchFills: async () => fills })
    const cands = await a.discover({ datanetId: '9', rubric, topN: 2 })
    expect(cands.length).toBeGreaterThanOrEqual(1)
    expect(cands[0].podName).toContain('HL perps')
    expect(cands[0].canonicalKey).toMatch(/^[0-9a-f]{16}$/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapter/hyperliquid/index.test.ts`
Expected: FAIL — cannot find module `./index.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/adapter/hyperliquid/index.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rankByMargin } from './rank.js'
import { buildHlDataset } from './dataset.js'
import type { DatanetAdapter, CandidatePod, AdapterContext } from '../types.js'
import type { DatanetRubric } from '../../rubric/types.js'

const execFileAsync = promisify(execFile)

export interface HlFetchers {
  fetchLeaderboard(): Promise<unknown>
  fetchFills(wallet: string): Promise<unknown>
}

const WINDOW = 'week'
const MIN_VLM = 100000

/** Default fetchers hit the HL public API (no auth). curl via subprocess keeps
 *  it dependency-free; confirm endpoints at integration. */
const defaultFetchers: HlFetchers = {
  async fetchLeaderboard() {
    const { stdout } = await execFileAsync('curl', ['-fsS', '--max-time', '60', 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'], { maxBuffer: 64 * 1024 * 1024 })
    return JSON.parse(stdout)
  },
  async fetchFills(wallet: string) {
    const now = Date.now()
    const body = JSON.stringify({ type: 'userFillsByTime', user: wallet, startTime: now - 7 * 86400_000, aggregateByTime: false })
    const { stdout } = await execFileAsync('curl', ['-fsS', '--max-time', '60', '-H', 'Content-Type: application/json', '-d', body, 'https://api.hyperliquid.xyz/info'], { maxBuffer: 64 * 1024 * 1024 })
    return JSON.parse(stdout)
  },
}

/** Reference adapter: HL leaderboard → margin-ranked wallets → labeled datasets.
 *  Routes to the TradingGym datanet (id 9 / name contains "tradinggym"). */
export function createHyperliquidAdapter(fetchers: HlFetchers = defaultFetchers): DatanetAdapter {
  return {
    id: 'hyperliquid',
    matches(datanetId: string, rubric: DatanetRubric): boolean {
      return datanetId === '9' || /tradinggym/i.test(rubric.name ?? '')
    },
    async discover(ctx: AdapterContext): Promise<CandidatePod[]> {
      const lb = await fetchers.fetchLeaderboard()
      const wallets = rankByMargin(lb, WINDOW, ctx.topN, MIN_VLM)
      const out: CandidatePod[] = []
      for (const w of wallets) {
        const fills = await fetchers.fetchFills(w)
        const cand = buildHlDataset(w, fills, ctx.datanetId)
        if (cand) out.push(cand)
      }
      return out
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapter/hyperliquid/index.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (54 prior + 4 minter + 2 rank + 3 dataset + 2 adapter = 65); typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/adapter/hyperliquid/index.ts src/adapter/hyperliquid/index.test.ts
git commit -m "feat(hl): hyperliquid adapter — discover() ranks wallets, builds candidates"
```

---

## Self-review (done while writing)

- **Spec coverage:** implements the design's "Adapter interface + Minter" + the Hyperliquid reference adapter. `DatanetAdapter`/`CandidatePod` match the design's interface; `selectMints` does dedup (vs ledger seen-keys + within-batch) + score-vs-`publisherSpec` + writes dataset bodies → `MintIntent[]`; honors `canMint`. The HL adapter ports the aeon margin-ranking + dataset-build (≥20-closed floor, canonical hash) behind an injected fetcher.
- **Minimal cross-unit change:** adds `selfScore?: number` to Plan-3 `MintIntent` (useful for digest); Plan-3 tests must stay green (Task 4 verifies).
- **Testability:** decision logic + ranking + dataset building are unit-tested against fixtures; only the HL HTTP fetch is integration-level (injected).
- **No placeholders:** complete code/commands/expected output throughout.
- **Type consistency:** `DatanetAdapter`, `CandidatePod`, `CandidateScorer`, `AdapterContext`, `selectMints`, `SelectMintsOpts`, `rankByMargin`, `buildHlDataset`, `createHyperliquidAdapter`, `HlFetchers` referenced consistently; `MintIntent`/`DatanetRubric` reused.
