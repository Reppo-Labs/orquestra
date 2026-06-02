# Orquestra — Phase 1, Plan 7: Runtime (cycle wiring + scheduler + Docker)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the units together into a running node: `runCycle` (orchestrator → voter ‖ minter → execute within budget → report), an internal `startScheduler` loop, and a `main` entrypoint + Dockerfile that onboards on first run, locks veREPPO, and runs on cadence.

**Architecture:** `runCycle(config, cycleId, deps)` is pure orchestration over **injected deps** (rubric loader, pod source, adapter registry, scorers, executor, ledger) — fully unit-tested with fakes; it never imports concrete network/LLM code. `startScheduler` is a thin interval loop, tested with fake timers. `main` (+ a real terminal `Prompter`, real deps, Dockerfile) is the integration entrypoint — typecheck + container build, not unit-tested.

**Tech Stack:** TypeScript, vitest. Reuses every prior unit (config, rubric, wallet/budget, voter, adapter+minter, onboarding). Docker (node:20-slim) bundling the `reppo` CLI + curl.

**Builds on:** Plans 1–6 (all merged).

---

## File structure (this plan)

- Create: `src/runtime/cycle.ts` — `runCycle`, `CycleDeps`, `CycleReport`.
- Create: `src/runtime/scheduler.ts` — `startScheduler`.
- Create: `src/runtime/prompter.ts` — `terminalPrompter` (readline-backed `Prompter`).
- Create: `src/index.ts` — `main()` entrypoint (onboard → lock → schedule; `configure` subcommand).
- Create: `Dockerfile`, `.dockerignore`.
- Modify: `package.json` — add `bin` + `start` script.
- Test: `src/runtime/cycle.test.ts`, `src/runtime/scheduler.test.ts`.

---

### Task 1: runCycle orchestration

**Files:**
- Create: `src/runtime/cycle.ts`
- Test: `src/runtime/cycle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/runtime/cycle.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCycle, type CycleDeps } from './cycle.js'
import { StrategyConfigSchema } from '../config/schema.js'
import type { DatanetRubric } from '../rubric/types.js'
import type { DatanetAdapter } from '../adapter/types.js'

const rubric = (over: Partial<DatanetRubric> = {}): DatanetRubric => ({
  datanetId: '9', name: 'TradingGym AI', goal: 'g', publisherSpec: 'p', voterRubric: 'v',
  canVote: true, canMint: true, status: 'ACTIVE',
  economics: { accessFeeReppo: 0, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'REPPO' },
  ...over,
})

const config = StrategyConfigSchema.parse({
  horizonDays: 30, cadenceHours: 6,
  stake: { lockReppo: 0, lockDurationDays: 30 },
  budget: { voteGasEthMax: 1, voteRateMaxPerCycle: 99, mintReppoMax: 1000, mintGasEthMax: 1 },
  datanets: {
    '9': { vote: true, mint: true, strictness: 'aggressive', adapter: 'hyperliquid' },
    '2': { vote: true, mint: false, strictness: 'aggressive' },
  },
})

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-cyc-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function deps(over: Partial<CycleDeps> = {}): CycleDeps {
  const adapter: DatanetAdapter = {
    id: 'hyperliquid', matches: () => true,
    discover: vi.fn(async () => [{ canonicalKey: 'k1', podName: 'HL perps', podDescription: 'd', dataset: { a: 1 } }]),
  }
  return {
    dataDir: dir, topN: 5,
    getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, name: id === '2' ? 'Geo' : 'TradingGym AI' })),
    getPodsAndFilter: vi.fn(async (_id: string) => ({
      pods: [{ podId: 'p1', validityEpoch: '100', name: 'pod', description: 'd' }],
      filter: { currentEpoch: '100', ownPodIds: [], votedPodIds: [] },
    })),
    getAdapter: (adapterId: string) => (adapterId === 'hyperliquid' ? adapter : undefined),
    voteScorer: { scorePod: async () => ({ score: 9, reason: 'good' }) },
    candidateScorer: { scoreCandidate: async () => ({ score: 9, reason: 'good' }) },
    seenKeysFor: async () => new Set<string>(),
    executor: {
      executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xvote' })),
      executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xmint' })),
    } as unknown as CycleDeps['executor'],
    ledger: { startCycle: vi.fn() } as unknown as CycleDeps['ledger'],
    ...over,
  }
}

describe('runCycle', () => {
  it('starts the cycle, votes on every vote-enabled datanet, mints only where adapter+canMint', async () => {
    const d = deps()
    const report = await runCycle(config, 'cycle-1', d)
    expect(d.ledger.startCycle).toHaveBeenCalledWith('cycle-1')
    expect((d.executor.executeVote as any).mock.calls.length).toBe(2)
    expect((d.executor.executeMint as any).mock.calls.length).toBe(1)
    const d9 = report.find((r) => r.datanetId === '9')!
    expect(d9.votes[0].txHash).toBe('0xvote')
    expect(d9.mints[0].txHash).toBe('0xmint')
    expect(report.find((r) => r.datanetId === '2')!.mints).toEqual([])
  })

  it('skips voting when rubric.canVote is false and minting when canMint is false', async () => {
    const d = deps({ getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, canVote: false, canMint: false })) })
    const report = await runCycle(config, 'c2', d)
    expect((d.executor.executeVote as any).mock.calls.length).toBe(0)
    expect((d.executor.executeMint as any).mock.calls.length).toBe(0)
    expect(report.every((r) => r.votes.length === 0 && r.mints.length === 0)).toBe(true)
  })

  it('does not mint a datanet with mint:true but no adapter configured', async () => {
    const cfg = StrategyConfigSchema.parse({
      ...config,
      datanets: { '5': { vote: false, mint: true, strictness: 'aggressive' } },
    })
    const d = deps()
    await runCycle(cfg, 'c3', d)
    expect((d.executor.executeMint as any).mock.calls.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/runtime/cycle.test.ts`
Expected: FAIL — cannot find module `./cycle.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runtime/cycle.ts
import { STRICTNESS_THRESHOLDS, type StrategyConfig } from '../config/schema.js'
import type { DatanetRubric } from '../rubric/types.js'
import type { DatanetAdapter, CandidateScorer } from '../adapter/types.js'
import type { PodScorer, VoterPod, VoteFilter } from '../voter/types.js'
import type { WalletExecutor } from '../wallet/executor.js'
import type { BudgetLedger } from '../wallet/ledger.js'
import type { ExecResult } from '../wallet/intents.js'
import { selectVotes } from '../voter/select.js'
import { selectMints } from '../minter/select.js'

export interface CycleDeps {
  dataDir: string
  topN: number
  getRubric(datanetId: string): Promise<DatanetRubric>
  getPodsAndFilter(datanetId: string): Promise<{ pods: VoterPod[]; filter: VoteFilter }>
  getAdapter(adapterId: string): DatanetAdapter | undefined
  voteScorer: PodScorer
  candidateScorer: CandidateScorer
  seenKeysFor(datanetId: string): Promise<Set<string>>
  executor: WalletExecutor
  ledger: BudgetLedger
}

export interface DatanetReport {
  datanetId: string
  votes: ExecResult[]
  mints: ExecResult[]
}
export type CycleReport = DatanetReport[]

/** One swarm cycle: for each configured datanet, vote (if enabled + capable) and
 *  mint (if enabled + adapter + capable). The executor enforces the budget. */
export async function runCycle(config: StrategyConfig, cycleId: string, deps: CycleDeps): Promise<CycleReport> {
  deps.ledger.startCycle(cycleId)
  const report: CycleReport = []

  for (const [datanetId, policy] of Object.entries(config.datanets)) {
    if (datanetId === '*') continue
    if (!policy.vote && !policy.mint) continue
    const rubric = await deps.getRubric(datanetId)
    const votes: ExecResult[] = []
    const mints: ExecResult[] = []

    if (policy.vote && rubric.canVote) {
      const { pods, filter } = await deps.getPodsAndFilter(datanetId)
      const intents = await selectVotes(datanetId, pods, rubric, policy.strictness, filter, deps.voteScorer)
      for (const intent of intents) votes.push(await deps.executor.executeVote(intent))
    }

    if (policy.mint && policy.adapter && rubric.canMint) {
      const adapter = deps.getAdapter(policy.adapter)
      if (adapter) {
        const candidates = await adapter.discover({ datanetId, rubric, topN: deps.topN })
        const seenKeys = await deps.seenKeysFor(datanetId)
        const minScore = STRICTNESS_THRESHOLDS[policy.strictness].like
        const intents = await selectMints(datanetId, candidates, rubric, {
          dataDir: deps.dataDir, minScore, seenKeys, scorer: deps.candidateScorer,
        })
        for (const intent of intents) mints.push(await deps.executor.executeMint(intent))
      }
    }

    report.push({ datanetId, votes, mints })
  }
  return report
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/runtime/cycle.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/cycle.ts src/runtime/cycle.test.ts
git commit -m "feat(runtime): runCycle — orchestrate vote+mint per datanet within budget"
```

---

### Task 2: Scheduler

**Files:**
- Create: `src/runtime/scheduler.ts`
- Test: `src/runtime/scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/runtime/scheduler.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startScheduler } from './scheduler.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('startScheduler', () => {
  it('runs the tick immediately, then every cadence interval', async () => {
    const tick = vi.fn(async () => {})
    const h = startScheduler(6, tick)
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6 * 3600_000)
    expect(tick).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(6 * 3600_000)
    expect(tick).toHaveBeenCalledTimes(3)
    h.stop()
    await vi.advanceTimersByTimeAsync(12 * 3600_000)
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('does not overlap ticks if one is still running (skips while busy)', async () => {
    let running = 0; let maxConcurrent = 0
    const tick = vi.fn(async () => {
      running++; maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((r) => setTimeout(r, 10 * 3600_000))
      running--
    })
    const h = startScheduler(6, tick)
    await vi.advanceTimersByTimeAsync(6 * 3600_000)
    expect(maxConcurrent).toBe(1)
    h.stop()
    await vi.advanceTimersByTimeAsync(20 * 3600_000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/runtime/scheduler.test.ts`
Expected: FAIL — cannot find module `./scheduler.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runtime/scheduler.ts
export interface SchedulerHandle {
  stop(): void
}

/** Run `tick` immediately, then every `cadenceHours`. Never overlaps: if a tick
 *  is still running when the interval fires, that fire is skipped. */
export function startScheduler(cadenceHours: number, tick: () => Promise<void>): SchedulerHandle {
  let busy = false
  let stopped = false
  const runGuarded = async () => {
    if (busy || stopped) return
    busy = true
    try {
      await tick()
    } catch (e) {
      console.error('orquestra: cycle failed:', (e as Error).message)
    } finally {
      busy = false
    }
  }
  void runGuarded()
  const id = setInterval(() => void runGuarded(), cadenceHours * 3600_000)
  return {
    stop() {
      stopped = true
      clearInterval(id)
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/runtime/scheduler.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/scheduler.ts src/runtime/scheduler.test.ts
git commit -m "feat(runtime): startScheduler — immediate + cadence loop, non-overlapping"
```

---

### Task 3: Terminal prompter + main entrypoint + Docker

**Files:**
- Create: `src/runtime/prompter.ts`, `src/index.ts`, `Dockerfile`, `.dockerignore`
- Modify: `package.json`

- [ ] **Step 1: Create `src/runtime/prompter.ts`**

```ts
// src/runtime/prompter.ts
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import type { Prompter } from '../onboarding/types.js'

/** Interactive terminal Prompter. Honors the Prompter contract: a blank answer
 *  returns the provided default. */
export function terminalPrompter(): Prompter & { close(): void } {
  const rl = createInterface({ input: stdin, output: stdout })
  return {
    async ask(question: string, def?: string): Promise<string> {
      const suffix = def !== undefined && def !== '' ? ` [${def}]` : ''
      const answer = (await rl.question(`${question}${suffix} `)).trim()
      return answer === '' ? (def ?? '') : answer
    },
    info(message: string): void {
      stdout.write(`${message}\n`)
    },
    close(): void {
      rl.close()
    },
  }
}
```

- [ ] **Step 2: Create `src/index.ts`**

```ts
// src/index.ts
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { loadConfig } from './config/load.js'
import { needsOnboarding, persistOnboarding } from './onboarding/persist.js'
import { runOnboarding } from './onboarding/interview.js'
import { buildStrategyConfig } from './onboarding/build.js'
import { terminalPrompter } from './runtime/prompter.js'
import { startScheduler } from './runtime/scheduler.js'
import { BudgetLedger } from './wallet/ledger.js'
import { WalletExecutor } from './wallet/executor.js'
import { defaultReppoCli } from './reppo/cli.js'
import { getDatanetRubric } from './rubric/load.js'
import { createHyperliquidAdapter } from './adapter/hyperliquid/index.js'
import { resolveModel, type LlmProvider } from './llm/model.js'
import { createLlmScorer } from './voter/score.js'
import { runCycle, type CycleDeps } from './runtime/cycle.js'
import type { StrategyConfig } from './config/schema.js'

const DATA_DIR = resolve(process.env.ORQUESTRA_DATA_DIR ?? './data')

async function onboard(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true })
  const p = terminalPrompter()
  try {
    const answers = await runOnboarding(p)
    const config = buildStrategyConfig(answers)
    persistOnboarding(DATA_DIR, config, answers.notes)
    p.info(`Saved strategy to ${DATA_DIR}. Run \`orquestra\` to start the node.`)
  } finally {
    p.close()
  }
}

async function start(): Promise<void> {
  if (needsOnboarding(DATA_DIR)) await onboard()
  const config: StrategyConfig = loadConfig(DATA_DIR)

  const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider
  const apiKey = process.env.LLM_API_KEY ?? ''
  const model = resolveModel(provider, apiKey)
  const scorer = createLlmScorer(model)
  const ledger = new BudgetLedger(DATA_DIR, config.budget)
  const executor = new WalletExecutor(defaultReppoCli, ledger)
  const hl = createHyperliquidAdapter()

  if (config.stake.lockReppo > 0) {
    const r = await executor.lock({
      amountReppo: config.stake.lockReppo,
      durationSeconds: config.stake.lockDurationDays * 86400,
      idempotencyKey: `lock-${config.stake.lockReppo}-${config.stake.lockDurationDays}`,
    })
    console.error(`orquestra: veREPPO lock ${r.status}${r.txHash ? ` (${r.txHash})` : ''}`)
  }

  const deps: CycleDeps = {
    dataDir: DATA_DIR,
    topN: 12,
    getRubric: (id) => getDatanetRubric(id),
    getPodsAndFilter: async () => ({ pods: [], filter: { currentEpoch: null, ownPodIds: [], votedPodIds: [] } }),
    getAdapter: (id) => (id === 'hyperliquid' ? hl : undefined),
    voteScorer: scorer,
    candidateScorer: {
      scoreCandidate: (c, r) =>
        scorer.scorePod({ podId: c.canonicalKey, validityEpoch: '', name: c.podName, description: c.podDescription }, r),
    },
    seenKeysFor: async () => new Set<string>(),
    executor,
    ledger,
  }

  const nDatanets = Object.keys(config.datanets).filter((k) => k !== '*').length
  console.error(`orquestra: starting — cadence ${config.cadenceHours}h, ${nDatanets} datanet(s)`)
  startScheduler(config.cadenceHours, async () => {
    const cycleId = new Date().toISOString()
    const report = await runCycle(config, cycleId, deps)
    const v = report.reduce((a, r) => a + r.votes.length, 0)
    const m = report.reduce((a, r) => a + r.mints.length, 0)
    console.error(`orquestra: cycle ${cycleId} — ${v} votes, ${m} mints executed`)
  })
}

const cmd = process.argv[2]
const run = cmd === 'configure' ? onboard : start
run().catch((e) => {
  console.error('orquestra: fatal:', (e as Error).message)
  process.exitCode = 1
})
```

> NOTE: `getPodsAndFilter` + `seenKeysFor` are wired to safe empty defaults here — the pod-list/vote-filter + minted-keys readers off the `reppo` CLI are a thin documented follow-up. The cycle, scheduler, budget, lock, voter, and adapter are all live; votes/mints fire as soon as those two readers are filled in. `candidateScorer` reuses the pod scorer against the candidate's name/description.

- [ ] **Step 3: Add `bin` + `start` to `package.json`**

Add a top-level `"bin": { "orquestra": "dist/index.js" },` and add `"start": "node dist/index.js",` to `scripts`.

- [ ] **Step 4: Create `.dockerignore`**

```
node_modules
dist
data
.git
*.log
```

- [ ] **Step 5: Create `Dockerfile`**

```dockerfile
FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && npm i -g @reppo/cli@latest
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV ORQUESTRA_DATA_DIR=/data
VOLUME /data
ENTRYPOINT ["node", "dist/index.js"]
```

- [ ] **Step 6: Typecheck + build + full suite**

Run: `npm run typecheck && npm run build && npm test`
Expected: typecheck exit 0; `tsc` build emits `dist/`; all tests PASS (74 prior + 3 cycle + 2 scheduler = 79).

- [ ] **Step 7: Commit**

```bash
git add src/runtime/prompter.ts src/index.ts Dockerfile .dockerignore package.json
git commit -m "feat(runtime): main entrypoint (onboard->lock->schedule) + Dockerfile"
```

---

## Self-review (done while writing)

- **Spec coverage:** implements the design's "Scheduler/runtime" + orchestrator wiring. `runCycle` = `orchestrator → [voter ‖ minter] → execute within budget → report`; `startScheduler` replaces GitHub Actions with an internal cadence loop; `main` does first-run onboarding (or `configure`), the initial veREPPO lock, and starts the loop; the Dockerfile makes it one `docker run` (model-agnostic via env, plaintext key, mounted `/data`).
- **Testability:** `runCycle` + `startScheduler` are unit-tested (fakes + fake timers); the scheduler is non-overlapping and catches tick errors so one bad cycle never kills the loop. `main`/Dockerfile are integration (typecheck + build).
- **Honest gap (documented):** `getPodsAndFilter` + `seenKeysFor` use empty defaults in `main` — the reppo-CLI pod-list/vote-filter/minted-keys readers are a thin follow-up; everything else is live end-to-end.
- **No placeholders in tested code.**
- **Type consistency:** `CycleDeps`, `CycleReport`, `DatanetReport`, `runCycle`, `SchedulerHandle`, `startScheduler`, `terminalPrompter` consistent; reuses every prior unit's public types.
