# Orquestra — Phase 1, Plan 2: Rubric loader

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a datanet's Reppo metadata into a typed `DatanetRubric` the voter/minter consume — `goal`, the publisher mint-spec, the voter scoring rubric, and economics.

**Architecture:** A **pure parser** (`parseDatanetRubric`) validated against a captured metadata fixture, plus a **loader** (`getDatanetRubric`) that takes an *injectable* fetcher (default: shell out to `reppo query datanet <id> --json`, CLI ≥0.7.0) so it is unit-testable without the network/CLI. Process-lifetime cache keyed by datanet id. If the rubric-essential fields are absent, throw `RubricUnavailableError` so the caller treats that datanet as non-operable rather than guessing.

**Tech Stack:** TypeScript, zod, vitest (already set up in Plan 1). Uses Node `child_process` for the default CLI fetcher.

**Builds on:** Plan 1 (Foundation). Depends on `reppo` CLI ≥0.7.0 surfacing datanet metadata on `query datanet --json`. **0.6.0 (latest published) does NOT** — so the default CLI fetcher is exercised only at integration time; all unit tests use a fixture of the metadata shape (the platform `subnet` object).

---

## File structure (this plan)

- Create: `src/rubric/types.ts` — `DatanetRubric` type + `RubricUnavailableError`.
- Create: `src/rubric/parse.ts` — `parseDatanetRubric(raw): DatanetRubric` (pure, zod).
- Create: `src/rubric/load.ts` — `getDatanetRubric(id, deps?)` (injectable fetcher + cache).
- Create: `src/reppo/queryDatanet.ts` — default fetcher: `reppo query datanet <id> --json`.
- Create: `test/fixtures/datanet-9.json` — captured metadata shape for tests.
- Test: `src/rubric/parse.test.ts`, `src/rubric/load.test.ts`.

---

### Task 1: Metadata fixture + types

**Files:**
- Create: `test/fixtures/datanet-9.json`
- Create: `src/rubric/types.ts`

- [ ] **Step 1: Create the fixture** (shape of `reppo query datanet 9 --json` metadata, CLI ≥0.7.0 — mirrors the platform `subnet` object)

```json
{
  "datanetId": "9",
  "subnetName": "TradingGym AI",
  "subnetDescription": "Personal RL gym and continuously updated training data marketplace for autonomous AI trading agents. High-signal, bias-free data optimized for improving agent performance in live perpetuals trading.",
  "onboardingPublishers": "Share your Hyperliquid perp trading data. Include: trade details (market, direction, size, leverage, fill price); your signal; outcome (PnL, win/loss, hold duration); metrics (win rate, Sharpe, max drawdown); market context; timeframe; verification (timestamps or tx hashes). Quality: real trades OR high-fidelity replay using actual Hyperliquid OHLCV. JSON/CSV with clear labels.",
  "onboardingVoters": "Score Pods 1-10 on usefulness for training agents to trade Hyperliquid perps. 8-10: clean, verifiable, actionable, entry+sizing+exit covered. 5-7: useful but incomplete. 2-4: noisy, hard to verify. 1: unusable. North star: would this help an autonomous agent compete in the Virtuals $100K?",
  "nativeTokenSymbol": "REPPO",
  "accessFeeREPPO": 50,
  "emissionsPerEpochREPPO": 500,
  "status": "ACTIVE",
  "upVoteVolume": 9668144,
  "downVoteVolume": 1568175
}
```

- [ ] **Step 2: Create `src/rubric/types.ts`**

```ts
export class RubricUnavailableError extends Error {}

/** A datanet's machine-readable policy, derived from its Reppo metadata. */
export interface DatanetRubric {
  datanetId: string
  name: string
  /** subnetDescription — the datanet's goal. */
  goal: string
  /** onboardingPublishers — what good data looks like (mint spec). */
  publisherSpec: string
  /** onboardingVoters — how to score pods 1-10 (vote rubric). */
  voterRubric: string
  status: string
  economics: {
    accessFeeReppo: number
    emissionsPerEpochReppo: number
    upVoteVolume: number
    downVoteVolume: number
    nativeTokenSymbol: string
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/datanet-9.json src/rubric/types.ts
git commit -m "feat(rubric): DatanetRubric type + metadata fixture"
```

---

### Task 2: Pure parser

**Files:**
- Create: `src/rubric/parse.ts`
- Test: `src/rubric/parse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/rubric/parse.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDatanetRubric } from './parse.js'
import { RubricUnavailableError } from './types.js'

const fixture = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/datanet-9.json'), 'utf-8'))

describe('parseDatanetRubric', () => {
  it('maps metadata fields into a DatanetRubric', () => {
    const r = parseDatanetRubric(fixture)
    expect(r.datanetId).toBe('9')
    expect(r.name).toBe('TradingGym AI')
    expect(r.goal).toMatch(/training data marketplace/)
    expect(r.publisherSpec).toMatch(/Hyperliquid perp trading data/)
    expect(r.voterRubric).toMatch(/Score Pods 1-10/)
    expect(r.economics.accessFeeReppo).toBe(50)
    expect(r.economics.upVoteVolume).toBe(9668144)
  })

  it('accepts tokenId as an alias for datanetId', () => {
    const { datanetId, ...rest } = fixture
    const r = parseDatanetRubric({ ...rest, tokenId: '9' })
    expect(r.datanetId).toBe('9')
  })

  it('throws RubricUnavailableError when the voter rubric is missing', () => {
    const { onboardingVoters, ...rest } = fixture
    expect(() => parseDatanetRubric(rest)).toThrow(RubricUnavailableError)
  })

  it('throws RubricUnavailableError when goal+publisherSpec are missing', () => {
    const { subnetDescription, onboardingPublishers, ...rest } = fixture
    expect(() => parseDatanetRubric(rest)).toThrow(RubricUnavailableError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/rubric/parse.test.ts`
Expected: FAIL — cannot find module `./parse.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/rubric/parse.ts
import { z } from 'zod'
import { type DatanetRubric, RubricUnavailableError } from './types.js'

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return Number.isFinite(n) ? n : 0
}

const MetadataSchema = z.object({
  datanetId: z.union([z.string(), z.number()]).optional(),
  tokenId: z.union([z.string(), z.number()]).optional(),
  subnetName: z.string().optional(),
  subnetDescription: z.string().optional(),
  onboardingPublishers: z.string().optional(),
  onboardingVoters: z.string().optional(),
  nativeTokenSymbol: z.string().optional(),
  accessFeeREPPO: z.unknown().optional(),
  emissionsPerEpochREPPO: z.unknown().optional(),
  status: z.string().optional(),
  upVoteVolume: z.unknown().optional(),
  downVoteVolume: z.unknown().optional(),
})

/** Parse Reppo datanet metadata into a DatanetRubric.
 *  Throws RubricUnavailableError if the rubric-essential fields are absent —
 *  the voter cannot operate generically on a datanet with no goal/vote rubric. */
export function parseDatanetRubric(raw: unknown): DatanetRubric {
  const m = MetadataSchema.parse(raw)
  const id = m.datanetId ?? m.tokenId
  const goal = m.subnetDescription?.trim() ?? ''
  const publisherSpec = m.onboardingPublishers?.trim() ?? ''
  const voterRubric = m.onboardingVoters?.trim() ?? ''

  if (id == null) throw new RubricUnavailableError('datanet metadata has no datanetId/tokenId')
  // Voting needs the voter rubric (or at least the goal); minting needs the publisher spec.
  if (!voterRubric && !goal) {
    throw new RubricUnavailableError(`datanet ${id}: no onboardingVoters or subnetDescription — cannot judge pods`)
  }
  if (!goal && !publisherSpec) {
    throw new RubricUnavailableError(`datanet ${id}: no subnetDescription or onboardingPublishers`)
  }

  return {
    datanetId: String(id),
    name: m.subnetName?.trim() ?? `datanet ${id}`,
    goal,
    publisherSpec,
    voterRubric,
    status: m.status ?? 'UNKNOWN',
    economics: {
      accessFeeReppo: num(m.accessFeeREPPO),
      emissionsPerEpochReppo: num(m.emissionsPerEpochREPPO),
      upVoteVolume: num(m.upVoteVolume),
      downVoteVolume: num(m.downVoteVolume),
      nativeTokenSymbol: m.nativeTokenSymbol ?? 'REPPO',
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/rubric/parse.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/rubric/parse.ts src/rubric/parse.test.ts
git commit -m "feat(rubric): pure parseDatanetRubric with RubricUnavailableError guards"
```

---

### Task 3: Default CLI fetcher

**Files:**
- Create: `src/reppo/queryDatanet.ts`

- [ ] **Step 1: Write the implementation** (thin subprocess wrapper — exercised at integration time, not unit-tested; isolated so the loader stays testable)

```ts
// src/reppo/queryDatanet.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Fetch a datanet's metadata JSON via the reppo CLI (>=0.7.0).
 *  Requires `reppo` on PATH and REPPO_NETWORK in env (default mainnet). */
export async function queryDatanetJson(datanetId: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    'reppo',
    ['query', 'datanet', datanetId, '--json'],
    { env: { ...process.env, REPPO_NETWORK: process.env.REPPO_NETWORK ?? 'mainnet' }, timeout: 60_000 },
  )
  return JSON.parse(stdout)
}

export type DatanetJsonFetcher = (datanetId: string) => Promise<unknown>
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/reppo/queryDatanet.ts
git commit -m "feat(reppo): queryDatanetJson CLI fetcher (>=0.7.0)"
```

---

### Task 4: Loader with injectable fetcher + cache

**Files:**
- Create: `src/rubric/load.ts`
- Test: `src/rubric/load.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/rubric/load.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDatanetRubric, clearRubricCache } from './load.js'
import { RubricUnavailableError } from './types.js'

const fixture = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/datanet-9.json'), 'utf-8'))

beforeEach(() => clearRubricCache())

describe('getDatanetRubric', () => {
  it('fetches + parses via the injected fetcher', async () => {
    const r = await getDatanetRubric('9', { fetcher: async () => fixture })
    expect(r.name).toBe('TradingGym AI')
    expect(r.voterRubric).toMatch(/North star/)
  })

  it('caches per id: the fetcher runs once across repeated calls', async () => {
    let calls = 0
    const fetcher = async () => { calls++; return fixture }
    await getDatanetRubric('9', { fetcher })
    await getDatanetRubric('9', { fetcher })
    expect(calls).toBe(1)
  })

  it('refetches when refresh: true', async () => {
    let calls = 0
    const fetcher = async () => { calls++; return fixture }
    await getDatanetRubric('9', { fetcher })
    await getDatanetRubric('9', { fetcher, refresh: true })
    expect(calls).toBe(2)
  })

  it('propagates RubricUnavailableError from the parser', async () => {
    const { onboardingVoters, subnetDescription, ...rest } = fixture
    await expect(getDatanetRubric('9', { fetcher: async () => rest })).rejects.toThrow(RubricUnavailableError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/rubric/load.test.ts`
Expected: FAIL — cannot find module `./load.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/rubric/load.ts
import { parseDatanetRubric } from './parse.js'
import { type DatanetRubric } from './types.js'
import { queryDatanetJson, type DatanetJsonFetcher } from '../reppo/queryDatanet.js'

const cache = new Map<string, DatanetRubric>()

export function clearRubricCache(): void {
  cache.clear()
}

export interface GetRubricDeps {
  /** Override the metadata source (default: reppo CLI). Injected in tests. */
  fetcher?: DatanetJsonFetcher
  /** Bypass + refresh the cache for this id. */
  refresh?: boolean
}

/** Load + parse a datanet's rubric, cached for the process lifetime. */
export async function getDatanetRubric(datanetId: string, deps: GetRubricDeps = {}): Promise<DatanetRubric> {
  const { fetcher = queryDatanetJson, refresh = false } = deps
  if (!refresh) {
    const hit = cache.get(datanetId)
    if (hit) return hit
  }
  const raw = await fetcher(datanetId)
  const rubric = parseDatanetRubric(raw)
  cache.set(datanetId, rubric)
  return rubric
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/rubric/load.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (Plan 1's 7 + this plan's 8 = 15); typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/rubric/load.ts src/rubric/load.test.ts
git commit -m "feat(rubric): getDatanetRubric loader with injectable fetcher + cache"
```

---

## Self-review (done while writing)

- **Spec coverage:** implements the design's "Rubric loader" component — reads datanet metadata (`subnetDescription`/`onboardingPublishers`/`onboardingVoters` + economics) and exposes it as `DatanetRubric` for the voter (voterRubric) and minter (publisherSpec). Matches "rubric sourced from Reppo via `reppo query datanet --json` (CLI ≥0.7.0)" and the "rubric → can vote; rubric + adapter → can mint" split (essential-field guards distinguish the two).
- **Testability:** the network/CLI boundary (`queryDatanetJson`) is isolated and injected, so all logic is unit-tested against a fixture; no live CLI needed (correct, since 0.7.0 is unreleased).
- **Open dependency restated:** once CLI 0.7.0 ships, confirm the exact JSON field names against `reppo query datanet 9 --json` and adjust `MetadataSchema` if they differ from the platform `subnet` object used here. The parser already tolerates `datanetId`|`tokenId` and string|number economics to reduce that risk.
- **No placeholders:** every step has complete code + commands + expected output.
- **Type consistency:** `DatanetRubric`, `RubricUnavailableError`, `parseDatanetRubric`, `getDatanetRubric`, `clearRubricCache`, `GetRubricDeps`, `DatanetJsonFetcher`, `queryDatanetJson` are used consistently across files and tests.
