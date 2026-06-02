# Orquestra — Phase 1, Plan 1: Foundation (scaffold + strategy config)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `orquestra` TypeScript project and the validated, persisted **strategy config** that every later component reads as policy.

**Architecture:** A Node + TypeScript app. Config is a zod-validated `strategy.config.json` on a mounted data dir; a `loadConfig()` returns a typed, defaulted `StrategyConfig` or a precise validation error. No agent/runtime logic yet — this plan is the foundation the rubric loader, wallet/budget manager, voter, adapter, onboarding, and scheduler all build on.

**Tech Stack:** Node ≥20, TypeScript, `vitest` (tests), `zod` (schema/validation). Later plans add: Vercel AI SDK (`ai` + provider packages) for model-agnostic LLM, `reppo` CLI ≥0.7.0 (subprocess) for chain ops, an internal scheduler, Docker.

---

## Phase 1 decomposition (this plan is unit 1 of 7)

Each unit is its own plan file under `docs/superpowers/plans/`, built in order; each produces working, tested software:

1. **Foundation** *(this plan)* — project scaffold + `StrategyConfig` schema + `loadConfig()`.
2. **Rubric loader** — `getDatanetRubric(id)` via `reppo query datanet --json` (CLI ≥0.7.0) → `{ goal, onboardingPublishers, onboardingVoters, economics }`, with a typed parse + cache.
3. **Wallet/Budget manager** — the only signer: `BudgetLedger` (per-pool caps, persisted) + a thin `reppo` CLI exec wrapper (lock, vote, mint-pod) gated by the ledger.
4. **Generic Voter** — score current-epoch pods 1–10 vs `onboardingVoters` (model-agnostic LLM) → emit vote intents per strictness threshold; own-pod/already-voted filters.
5. **Hyperliquid adapter + Minter** — `DatanetAdapter` interface + the `hyperliquid` reference adapter (port `prefetch-hl` + dataset builder) → mint intents.
6. **Onboarding wizard** — interactive LLM interview → writes `strategy.config.json` (+ `strategy-notes.md`); `orquestra configure`.
7. **Scheduler + Docker** — internal cron loop running orchestrator → [voter ‖ minter] → execute → notify; Dockerfile + `docker run` entrypoint that drops to onboarding on first run.

---

## File structure (this plan)

- Create: `package.json` — project manifest + scripts.
- Create: `tsconfig.json` — strict TS config.
- Create: `vitest.config.ts` — test runner config.
- Create: `.gitignore` — ignore `node_modules`, `dist`, secrets, `data/`.
- Create: `.env.example` — documented env vars (no real values).
- Create: `README.md` — one-paragraph what/run.
- Create: `src/config/schema.ts` — `StrategyConfig` zod schema + inferred type.
- Create: `src/config/load.ts` — `loadConfig(dataDir)` reader/validator.
- Test: `src/config/schema.test.ts`, `src/config/load.test.ts`.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `README.md`

- [ ] **Step 1: Create `.gitignore`**

```gitignore
node_modules/
dist/
*.tsbuildinfo
# Secrets & local node state — NEVER commit
.env
.env.*
!.env.example
data/
*.key
# OS / editor
.DS_Store
.idea/
.vscode/
*.log
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "orquestra",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
```

- [ ] **Step 5: Create `.env.example`**

```dotenv
# Wallet that holds REPPO. Use a DEDICATED wallet, never your main one.
# Plaintext at rest — bounded by the budget caps in strategy.config.json.
REPPO_PRIVATE_KEY=

# Model-agnostic LLM. Set provider + that provider's key.
# provider: anthropic | openai | google | ...
LLM_PROVIDER=anthropic
LLM_API_KEY=

# Where strategy.config.json + ledgers live (mounted volume in Docker).
ORQUESTRA_DATA_DIR=./data
```

- [ ] **Step 6: Create `README.md`**

```markdown
# orquestra

Reppo's official agentic swarm node. Run a node on your machine: it curates
(votes) across any Datanet and mints where it has a data adapter, bounded by a
budget you set in an LLM onboarding interview, signing with your own wallet.

See `docs/design/2026-06-02-orquestra-design.md` for the architecture.

## Develop
- `npm install`
- `npm test`
```

- [ ] **Step 7: Install deps and verify the toolchain**

Run: `npm install && npm run typecheck`
Expected: install succeeds; `typecheck` exits 0 (no source yet → no errors).

- [ ] **Step 8: Commit**

```bash
git add .gitignore package.json tsconfig.json vitest.config.ts .env.example README.md package-lock.json
git commit -m "chore: scaffold orquestra (ts + vitest + zod)"
```

---

### Task 2: StrategyConfig schema

**Files:**
- Create: `src/config/schema.ts`
- Test: `src/config/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/config/schema.test.ts
import { describe, it, expect } from 'vitest'
import { StrategyConfigSchema, STRICTNESS_THRESHOLDS } from './schema.js'

const valid = {
  horizonDays: 30,
  cadenceHours: 6,
  stake: { lockReppo: 500, lockDurationDays: 30 },
  budget: { voteGasEthMax: 0.02, voteRateMaxPerCycle: 25, mintReppoMax: 100, mintGasEthMax: 0.05 },
  datanets: { '9': { vote: true, mint: true, strictness: 'conservative', adapter: 'hyperliquid' } },
  notes: 'be picky',
}

describe('StrategyConfigSchema', () => {
  it('accepts a valid config and applies the wildcard default', () => {
    const parsed = StrategyConfigSchema.parse(valid)
    expect(parsed.datanets['9'].strictness).toBe('conservative')
    expect(parsed.datanets['*']).toEqual({ vote: false, mint: false, strictness: 'balanced' })
  })

  it('rejects an unknown strictness', () => {
    const bad = { ...valid, datanets: { '9': { vote: true, strictness: 'reckless' } } }
    expect(() => StrategyConfigSchema.parse(bad)).toThrow()
  })

  it('rejects a non-positive horizon', () => {
    expect(() => StrategyConfigSchema.parse({ ...valid, horizonDays: 0 })).toThrow()
  })

  it('exposes like/dislike thresholds per strictness on the 1-10 scale', () => {
    expect(STRICTNESS_THRESHOLDS.conservative).toEqual({ like: 8, dislike: 4 })
    expect(STRICTNESS_THRESHOLDS.aggressive.like).toBeLessThan(STRICTNESS_THRESHOLDS.conservative.like)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/schema.test.ts`
Expected: FAIL — cannot find module `./schema.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/config/schema.ts
import { z } from 'zod'

export const STRICTNESS_THRESHOLDS = {
  conservative: { like: 8, dislike: 4 },
  balanced: { like: 7, dislike: 3 },
  aggressive: { like: 6, dislike: 2 },
} as const

export const Strictness = z.enum(['conservative', 'balanced', 'aggressive'])

const DatanetPolicy = z
  .object({
    vote: z.boolean().default(false),
    mint: z.boolean().default(false),
    strictness: Strictness.default('balanced'),
    adapter: z.string().optional(),
  })
  .strict()

export const StrategyConfigSchema = z
  .object({
    horizonDays: z.number().int().positive(),
    cadenceHours: z.number().int().positive(),
    stake: z.object({
      lockReppo: z.number().nonnegative(),
      lockDurationDays: z.number().int().positive(),
    }),
    budget: z.object({
      voteGasEthMax: z.number().nonnegative(),
      voteRateMaxPerCycle: z.number().int().nonnegative(),
      mintReppoMax: z.number().nonnegative(),
      mintGasEthMax: z.number().nonnegative(),
    }),
    datanets: z.record(z.string(), DatanetPolicy),
    notes: z.string().default(''),
  })
  .transform((cfg) => ({
    ...cfg,
    datanets: { '*': { vote: false, mint: false, strictness: 'balanced' as const }, ...cfg.datanets },
  }))

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/config/schema.test.ts
git commit -m "feat(config): strategy config zod schema + strictness thresholds"
```

---

### Task 3: Config loader

**Files:**
- Create: `src/config/load.ts`
- Test: `src/config/load.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/config/load.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, ConfigNotFoundError, ConfigInvalidError } from './load.js'

let dir: string
const writeCfg = (obj: unknown) => writeFileSync(join(dir, 'strategy.config.json'), JSON.stringify(obj))

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('loadConfig', () => {
  it('throws ConfigNotFoundError when no config exists (first run)', () => {
    expect(() => loadConfig(dir)).toThrow(ConfigNotFoundError)
  })

  it('loads and validates a good config', () => {
    writeCfg({
      horizonDays: 30, cadenceHours: 6,
      stake: { lockReppo: 500, lockDurationDays: 30 },
      budget: { voteGasEthMax: 0.02, voteRateMaxPerCycle: 25, mintReppoMax: 100, mintGasEthMax: 0.05 },
      datanets: { '9': { vote: true, strictness: 'balanced' } },
    })
    const cfg = loadConfig(dir)
    expect(cfg.datanets['9'].vote).toBe(true)
    expect(cfg.notes).toBe('')
  })

  it('throws ConfigInvalidError with a readable message on a bad config', () => {
    writeCfg({ horizonDays: -1 })
    expect(() => loadConfig(dir)).toThrow(ConfigInvalidError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/load.test.ts`
Expected: FAIL — cannot find module `./load.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/config/load.ts
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { StrategyConfigSchema, type StrategyConfig } from './schema.js'

export class ConfigNotFoundError extends Error {}
export class ConfigInvalidError extends Error {}

export const CONFIG_FILENAME = 'strategy.config.json'

/** Load + validate the strategy config from `dataDir`.
 *  Throws ConfigNotFoundError (first run → caller runs onboarding) or
 *  ConfigInvalidError (present but malformed → surface, do not silently default). */
export function loadConfig(dataDir: string): StrategyConfig {
  const path = join(dataDir, CONFIG_FILENAME)
  if (!existsSync(path)) {
    throw new ConfigNotFoundError(`No ${CONFIG_FILENAME} in ${dataDir} — run \`orquestra configure\``)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    throw new ConfigInvalidError(`${CONFIG_FILENAME} is not valid JSON: ${(e as Error).message}`)
  }
  const result = StrategyConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigInvalidError(`${CONFIG_FILENAME} failed validation:\n${result.error.toString()}`)
  }
  return result.data
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/load.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/config/load.ts src/config/load.test.ts
git commit -m "feat(config): loadConfig with not-found vs invalid errors"
```

---

## Self-review (done while writing)

- **Spec coverage (this unit):** the `strategy.config.json` shape (horizon, cadence, stake, budget pools, per-datanet vote/mint/strictness/adapter, notes) and strictness→1–10 thresholds from the design's "Strategy config + budget pools" section are implemented and tested. The `'*'` wildcard default (datanets unlisted = no action) matches the spec's `"*": { "vote": false }`.
- **Deferred to later units (intentionally, each its own plan):** rubric loader (2), wallet/budget enforcement (3), voter (4), adapter/minter (5), onboarding writer (6), scheduler/Docker (7). None are placeholders within this plan — they are separate, sequenced plans.
- **Type consistency:** `StrategyConfig`, `STRICTNESS_THRESHOLDS`, `Strictness`, `loadConfig`, `CONFIG_FILENAME`, `ConfigNotFoundError`, `ConfigInvalidError` are referenced consistently across schema/load and their tests.
- **No placeholders:** every step has complete code/commands + expected output.
