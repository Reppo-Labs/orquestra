# Orquestra — Phase 1, Plan 6: Onboarding wizard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-run interview → a validated `strategy.config.json` (+ `strategy-notes.md`). The interview gathers datanet choices, stake, budget caps, cadence, and freeform strategy notes, then assembles + validates the config the agents read.

**Architecture:** `buildStrategyConfig(answers)` is a pure mapper that assembles `OnboardingAnswers` into a `StrategyConfig` and validates it via Plan 1's `StrategyConfigSchema` (bad answers throw). The interview (`runOnboarding`) drives an **injected `Prompter`** (production: an interactive/LLM-backed terminal prompt; tests: a scripted fake), so it's fully unit-tested. Persistence + first-run detection round it out. The initial veREPPO lock is performed at startup (Plan 7), not here, so this unit signs nothing and stays testable.

**Tech Stack:** TypeScript, zod, vitest. Reuses `StrategyConfigSchema`/`StrategyConfig`/`StrictnessLevel` (Plan 1), `loadConfig`/`CONFIG_FILENAME` (Plan 1).

**Builds on:** Plans 1–5.

---

## File structure (this plan)

- Create: `src/onboarding/types.ts` — `OnboardingAnswers`, `Prompter`.
- Create: `src/onboarding/build.ts` — `buildStrategyConfig(answers)`.
- Create: `src/onboarding/persist.ts` — `persistOnboarding`, `needsOnboarding`.
- Create: `src/onboarding/interview.ts` — `runOnboarding(prompter)`.
- Test: `src/onboarding/build.test.ts`, `src/onboarding/persist.test.ts`, `src/onboarding/interview.test.ts`.

---

### Task 1: Types + buildStrategyConfig

**Files:**
- Create: `src/onboarding/types.ts`
- Create: `src/onboarding/build.ts`
- Test: `src/onboarding/build.test.ts`

- [ ] **Step 1: Write `src/onboarding/types.ts`**

```ts
// src/onboarding/types.ts
import type { StrictnessLevel } from '../config/schema.js'

export interface DatanetChoice {
  id: string
  vote: boolean
  mint: boolean
  strictness: StrictnessLevel
  adapter?: string
}

export interface OnboardingAnswers {
  datanets: DatanetChoice[]
  lockReppo: number
  lockDurationDays: number
  voteGasEthMax: number
  voteRateMaxPerCycle: number
  mintReppoMax: number
  mintGasEthMax: number
  horizonDays: number
  cadenceHours: number
  notes: string
}

/** Abstracts the interview I/O. Production: interactive/LLM terminal; tests: scripted. */
export interface Prompter {
  /** Ask a question; returns the user's answer (or the default if blank). */
  ask(question: string, def?: string): Promise<string>
  /** Print informational text (recommendations, summaries). */
  info(message: string): void
}
```

- [ ] **Step 2: Write the failing test**

```ts
// src/onboarding/build.test.ts
import { describe, it, expect } from 'vitest'
import { buildStrategyConfig } from './build.js'
import type { OnboardingAnswers } from './types.js'

const answers = (): OnboardingAnswers => ({
  datanets: [
    { id: '9', vote: true, mint: true, strictness: 'conservative', adapter: 'hyperliquid' },
    { id: '2', vote: true, mint: false, strictness: 'balanced' },
  ],
  lockReppo: 500, lockDurationDays: 30,
  voteGasEthMax: 0.02, voteRateMaxPerCycle: 25, mintReppoMax: 100, mintGasEthMax: 0.05,
  horizonDays: 30, cadenceHours: 6, notes: 'be picky on TradingGym',
})

describe('buildStrategyConfig', () => {
  it('assembles a valid StrategyConfig from answers', () => {
    const cfg = buildStrategyConfig(answers())
    expect(cfg.datanets['9'].mint).toBe(true)
    expect(cfg.datanets['9'].adapter).toBe('hyperliquid')
    expect(cfg.datanets['2'].mint).toBe(false)
    expect(cfg.stake.lockReppo).toBe(500)
    expect(cfg.budget.mintReppoMax).toBe(100)
    expect(cfg.notes).toBe('be picky on TradingGym')
    expect(cfg.datanets['*'].vote).toBe(false) // wildcard default from schema
  })

  it('throws on an invalid answer (e.g. negative horizon) via schema validation', () => {
    expect(() => buildStrategyConfig({ ...answers(), horizonDays: -1 })).toThrow()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/onboarding/build.test.ts`
Expected: FAIL — cannot find module `./build.js`.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/onboarding/build.ts
import { StrategyConfigSchema, type StrategyConfig } from '../config/schema.js'
import type { OnboardingAnswers } from './types.js'

/** Assemble interview answers into a validated StrategyConfig (throws if invalid). */
export function buildStrategyConfig(a: OnboardingAnswers): StrategyConfig {
  const datanets: Record<string, unknown> = {}
  for (const d of a.datanets) {
    datanets[d.id] = { vote: d.vote, mint: d.mint, strictness: d.strictness, ...(d.adapter ? { adapter: d.adapter } : {}) }
  }
  return StrategyConfigSchema.parse({
    horizonDays: a.horizonDays,
    cadenceHours: a.cadenceHours,
    stake: { lockReppo: a.lockReppo, lockDurationDays: a.lockDurationDays },
    budget: {
      voteGasEthMax: a.voteGasEthMax,
      voteRateMaxPerCycle: a.voteRateMaxPerCycle,
      mintReppoMax: a.mintReppoMax,
      mintGasEthMax: a.mintGasEthMax,
    },
    datanets,
    notes: a.notes,
  })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/onboarding/build.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/onboarding/types.ts src/onboarding/build.ts src/onboarding/build.test.ts
git commit -m "feat(onboarding): OnboardingAnswers + buildStrategyConfig (validated)"
```

---

### Task 2: Persistence + first-run detection

**Files:**
- Create: `src/onboarding/persist.ts`
- Test: `src/onboarding/persist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/onboarding/persist.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistOnboarding, needsOnboarding } from './persist.js'
import { loadConfig } from '../config/load.js'
import { buildStrategyConfig } from './build.js'
import type { OnboardingAnswers } from './types.js'

const ans: OnboardingAnswers = {
  datanets: [{ id: '9', vote: true, mint: true, strictness: 'balanced', adapter: 'hyperliquid' }],
  lockReppo: 500, lockDurationDays: 30, voteGasEthMax: 0.02, voteRateMaxPerCycle: 25,
  mintReppoMax: 100, mintGasEthMax: 0.05, horizonDays: 30, cadenceHours: 6, notes: 'hi',
}
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-onb-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('onboarding persistence', () => {
  it('needsOnboarding is true before, false after persisting', () => {
    expect(needsOnboarding(dir)).toBe(true)
    persistOnboarding(dir, buildStrategyConfig(ans), ans.notes)
    expect(needsOnboarding(dir)).toBe(false)
  })

  it('writes a config loadConfig can read back, plus strategy-notes.md', () => {
    persistOnboarding(dir, buildStrategyConfig(ans), 'my strategy notes')
    const cfg = loadConfig(dir)
    expect(cfg.datanets['9'].adapter).toBe('hyperliquid')
    expect(readFileSync(join(dir, 'strategy-notes.md'), 'utf-8')).toContain('my strategy notes')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/onboarding/persist.test.ts`
Expected: FAIL — cannot find module `./persist.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/onboarding/persist.ts
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILENAME } from '../config/load.js'
import type { StrategyConfig } from '../config/schema.js'

const NOTES_FILE = 'strategy-notes.md'

/** True when no config exists yet (first run → run the interview). */
export function needsOnboarding(dataDir: string): boolean {
  return !existsSync(join(dataDir, CONFIG_FILENAME))
}

/** Persist the validated config + the freeform notes to the data dir. */
export function persistOnboarding(dataDir: string, config: StrategyConfig, notes: string): void {
  writeFileSync(join(dataDir, CONFIG_FILENAME), JSON.stringify(config, null, 2))
  writeFileSync(join(dataDir, NOTES_FILE), `# Orquestra strategy notes\n\n${notes}\n`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/onboarding/persist.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/persist.ts src/onboarding/persist.test.ts
git commit -m "feat(onboarding): persist config + notes; needsOnboarding first-run check"
```

---

### Task 3: Interview runner

**Files:**
- Create: `src/onboarding/interview.ts`
- Test: `src/onboarding/interview.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/onboarding/interview.test.ts
import { describe, it, expect } from 'vitest'
import { runOnboarding } from './interview.js'
import type { Prompter } from './types.js'

/** Scripted prompter: returns queued answers in order; blank falls back to the default. */
function scripted(answers: string[]): Prompter {
  let i = 0
  return {
    ask: async (_q: string, def?: string) => {
      const a = answers[i++]
      return a === undefined || a === '' ? (def ?? '') : a
    },
    info: () => {},
  }
}

describe('runOnboarding', () => {
  it('collects answers into an OnboardingAnswers via the prompter', async () => {
    const p = scripted([
      '9',            // datanet ids (comma-separated)
      'y', 'y', 'conservative', 'hyperliquid', // datanet 9: vote? mint? strictness adapter
      '500', '30',    // lockReppo, lockDurationDays
      '0.02', '25', '100', '0.05', // voteGasEthMax, voteRateMaxPerCycle, mintReppoMax, mintGasEthMax
      '30', '6',      // horizonDays, cadenceHours
      'be picky',     // notes
    ])
    const ans = await runOnboarding(p)
    expect(ans.datanets).toHaveLength(1)
    expect(ans.datanets[0]).toEqual({ id: '9', vote: true, mint: true, strictness: 'conservative', adapter: 'hyperliquid' })
    expect(ans.lockReppo).toBe(500)
    expect(ans.cadenceHours).toBe(6)
    expect(ans.notes).toBe('be picky')
  })

  it('uses defaults when answers are blank, and parses y/n loosely', async () => {
    const p = scripted([
      '9',
      '', 'n', '', '',     // vote (default y), mint n, strictness default, adapter default (none)
      '', '', '', '', '', '', '', '', '', // numeric fields + notes all default/blank
    ])
    const ans = await runOnboarding(p)
    expect(ans.datanets[0].vote).toBe(true)   // blank → default yes
    expect(ans.datanets[0].mint).toBe(false)
    expect(ans.datanets[0].strictness).toBe('balanced') // default
    expect(ans.datanets[0].adapter).toBeUndefined()
    expect(ans.lockReppo).toBeGreaterThanOrEqual(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/onboarding/interview.test.ts`
Expected: FAIL — cannot find module `./interview.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/onboarding/interview.ts
import type { Prompter, OnboardingAnswers, DatanetChoice } from './types.js'
import type { StrictnessLevel } from '../config/schema.js'

const yes = (s: string): boolean => /^(y|yes|true|1)$/i.test(s.trim())
const STRICTNESS: StrictnessLevel[] = ['conservative', 'balanced', 'aggressive']
const asStrictness = (s: string): StrictnessLevel =>
  (STRICTNESS as string[]).includes(s.trim()) ? (s.trim() as StrictnessLevel) : 'balanced'
const numOr = (s: string, def: number): number => {
  const n = Number(s)
  return Number.isFinite(n) ? n : def
}

/** Drive the first-run interview over an injected Prompter. All I/O is the
 *  Prompter's; this returns structured answers for buildStrategyConfig. */
export async function runOnboarding(p: Prompter): Promise<OnboardingAnswers> {
  p.info('Orquestra setup — configure how your node votes, mints, and stakes.')

  const idsRaw = await p.ask('Which datanet ids do you want to participate in? (comma-separated)', '9')
  const ids = idsRaw.split(',').map((s) => s.trim()).filter(Boolean)

  const datanets: DatanetChoice[] = []
  for (const id of ids) {
    const vote = yes(await p.ask(`Datanet ${id}: vote on pods? (Y/n)`, 'y'))
    const mint = yes(await p.ask(`Datanet ${id}: mint pods? (y/N)`, 'n'))
    const strictness = asStrictness(await p.ask(`Datanet ${id}: strictness (conservative/balanced/aggressive)`, 'balanced'))
    const adapter = (await p.ask(`Datanet ${id}: mint adapter (blank for none)`, '')).trim() || undefined
    datanets.push({ id, vote, mint, strictness, adapter })
  }

  const lockReppo = numOr(await p.ask('How much REPPO to lock (veREPPO voting power)?', '0'), 0)
  const lockDurationDays = numOr(await p.ask('Lock duration in days?', '30'), 30)
  const voteGasEthMax = numOr(await p.ask('Max ETH gas for votes (over the horizon)?', '0.02'), 0.02)
  const voteRateMaxPerCycle = numOr(await p.ask('Max votes per cycle?', '25'), 25)
  const mintReppoMax = numOr(await p.ask('Max REPPO to spend on mints (over the horizon)?', '0'), 0)
  const mintGasEthMax = numOr(await p.ask('Max ETH gas for mints (over the horizon)?', '0.05'), 0.05)
  const horizonDays = numOr(await p.ask('Budget horizon in days?', '30'), 30)
  const cadenceHours = numOr(await p.ask('How often should the node run, in hours?', '6'), 6)
  const notes = (await p.ask('Any freeform strategy notes? (optional)', '')).trim()

  return {
    datanets, lockReppo, lockDurationDays, voteGasEthMax, voteRateMaxPerCycle,
    mintReppoMax, mintGasEthMax, horizonDays, cadenceHours, notes,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/onboarding/interview.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (67 prior + 6 new = 73); typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/onboarding/interview.ts src/onboarding/interview.test.ts
git commit -m "feat(onboarding): runOnboarding structured interview over injected Prompter"
```

---

## Self-review (done while writing)

- **Spec coverage:** implements the design's onboarding wizard — first-run interview gathering datanet choices, stake (lock amount+duration), budget caps, cadence, and freeform notes → a validated `strategy.config.json` (+ `strategy-notes.md`). `needsOnboarding` drives the first-run path; `orquestra configure` (Plan 7) re-runs it. The initial veREPPO lock is deferred to startup (Plan 7), keeping this unit signing-free + testable.
- **Testability:** the interview I/O is an injected `Prompter`, so the whole flow is unit-tested with a scripted fake; `buildStrategyConfig` validates via the Plan-1 schema (bad answers throw).
- **LLM note:** the production `Prompter` may be LLM-backed (conversational, recommends datanets from `reppo list datanets`), but financial params are committed as explicit structured answers — safer than freeform for staked capital. Conversational polish is a later enhancement; the structured contract here is the durable core.
- **No placeholders:** complete code/commands/expected output.
- **Type consistency:** `OnboardingAnswers`, `DatanetChoice`, `Prompter`, `buildStrategyConfig`, `persistOnboarding`, `needsOnboarding`, `runOnboarding` consistent; reuses `StrategyConfigSchema`/`StrictnessLevel`/`CONFIG_FILENAME`.
