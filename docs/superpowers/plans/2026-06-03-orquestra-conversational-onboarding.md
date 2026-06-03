# Orquestra — Conversational onboarding (replaces the structured wizard)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed-question onboarding wizard with an **LLM chat** (powered by the user's configured provider, e.g. Surplus) where the user can ask things like *"what datanets are available?"*, get recommendations, and confirm choices. The assistant calls tools to answer with live Reppo data and finalizes a validated `strategy.config.json`.

**Architecture:** A tool-using agent loop (AI SDK `generateText` + `tools`, model-agnostic). Tools: `list_datanets` (live catalog), `get_datanet_details` (rubric + mint-capability), `finalize` (validates `OnboardingAnswers` via `buildStrategyConfig`, captures them, ends the chat). User turns come from an injected `Prompter`; assistant turns print to it. Tool impls + the finalize validator are injected/pure → unit-tested; the loop is tested with `MockLanguageModelV1`. The structured `interview.ts` wizard is **removed** (decision: conversational-only). `buildStrategyConfig` / `persistOnboarding` / types are reused.

**Tech Stack:** TypeScript, zod, vitest, `ai`@4 (`tool`, `generateText`, `ai/test` `MockLanguageModelV1`). Reuses `OnboardingAnswers`/`Prompter` (onboarding), `buildStrategyConfig`, `getDatanetRubric` (rubric), `resolveModel` (llm).

**Builds on:** all Phase-1 units (merged).

---

## File structure

- Create: `src/reppo/listDatanets.ts` — `parseDatanetList` (pure) + `listDatanetsJson` (CLI reader).
- Create: `src/onboarding/schema.ts` — `OnboardingAnswersSchema` (zod) + `validateAnswers`.
- Create: `src/onboarding/agent.ts` — `buildOnboardingTools`, `runConversationalOnboarding`.
- Modify: `src/index.ts` — `onboard()` runs the conversational agent (build model + prompter + deps).
- Delete: `src/onboarding/interview.ts` + `src/onboarding/interview.test.ts` (structured wizard, replaced).
- Modify: `.env.example` / `Dockerfile` comment — onboarding now requires an LLM key.
- Create fixture: `test/fixtures/datanets-list.json`.
- Test: `src/reppo/listDatanets.test.ts`, `src/onboarding/schema.test.ts`, `src/onboarding/agent.test.ts`.

---

### Task 1: Datanet catalog reader

**Files:** Create `test/fixtures/datanets-list.json`, `src/reppo/listDatanets.ts`, `src/reppo/listDatanets.test.ts`

- [ ] **Step 1: Fixture** (`reppo list datanets --json` shape)

```json
{
  "network": "mainnet",
  "datanets": [
    { "id": "9", "name": "TradingGym AI", "status": "ACTIVE", "accessFeeREPPO": "50", "emissionsPerEpochREPPO": "500", "upVoteVolume": "9668144", "downVoteVolume": "1568175", "subnetDescription": "HL perp training data." },
    { "id": "2", "name": "Geopolitical Flashpoint and Misinfo Detection", "status": "ACTIVE", "accessFeeREPPO": "100", "emissionsPerEpochREPPO": "3000", "upVoteVolume": "136169069", "downVoteVolume": "14213857" }
  ]
}
```

- [ ] **Step 2: Failing test**

```ts
// src/reppo/listDatanets.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDatanetList } from './listDatanets.js'

const raw = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/datanets-list.json'), 'utf-8'))

describe('parseDatanetList', () => {
  it('maps the catalog into compact summaries', () => {
    const list = parseDatanetList(raw)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ id: '9', name: 'TradingGym AI', accessFeeReppo: 50, upVoteVolume: 9668144 })
    expect(list[0].description).toContain('HL perp')
  })
  it('returns [] on malformed input', () => {
    expect(parseDatanetList({})).toEqual([])
    expect(parseDatanetList(null)).toEqual([])
  })
})
```

- [ ] **Step 3: Run → fail.** `npx vitest run src/reppo/listDatanets.test.ts` (cannot find module).

- [ ] **Step 4: Implement**

```ts
// src/reppo/listDatanets.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DatanetSummary {
  id: string
  name: string
  status: string
  description: string
  accessFeeReppo: number
  emissionsPerEpochReppo: number
  upVoteVolume: number
  downVoteVolume: number
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** Map `reppo list datanets --json` into compact summaries for the onboarding agent. */
export function parseDatanetList(raw: unknown): DatanetSummary[] {
  const rows = (raw as { datanets?: unknown[] })?.datanets
  if (!Array.isArray(rows)) return []
  return rows.map((r) => {
    const d = r as Record<string, unknown>
    return {
      id: String(d.id ?? d.tokenId ?? ''),
      name: String(d.name ?? d.subnetName ?? `datanet ${String(d.id ?? '')}`),
      status: String(d.status ?? 'UNKNOWN'),
      description: String(d.subnetDescription ?? d.description ?? '').trim(),
      accessFeeReppo: num(d.accessFeeREPPO),
      emissionsPerEpochReppo: num(d.emissionsPerEpochREPPO),
      upVoteVolume: num(d.upVoteVolume),
      downVoteVolume: num(d.downVoteVolume),
    }
  }).filter((d) => d.id !== '')
}

/** Live catalog via the reppo CLI. */
export async function listDatanetsJson(): Promise<DatanetSummary[]> {
  const { stdout } = await execFileAsync('reppo', ['list', 'datanets', '--status', 'ACTIVE', '--json'], {
    env: { ...process.env, REPPO_NETWORK: process.env.REPPO_NETWORK ?? 'mainnet' }, timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  })
  return parseDatanetList(JSON.parse(stdout))
}
```

- [ ] **Step 5: Run → pass (2).** Commit: `git add test/fixtures/datanets-list.json src/reppo/listDatanets.ts src/reppo/listDatanets.test.ts && git -c commit.gpgsign=false commit -m "feat(reppo): listDatanets catalog reader + parser"`

---

### Task 2: OnboardingAnswers schema + validator

**Files:** Create `src/onboarding/schema.ts`, `src/onboarding/schema.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/onboarding/schema.test.ts
import { describe, it, expect } from 'vitest'
import { OnboardingAnswersSchema, validateAnswers } from './schema.js'

const good = {
  datanets: [{ id: '9', vote: true, mint: true, strictness: 'conservative', adapter: 'hyperliquid' }],
  lockReppo: 500, lockDurationDays: 30, voteGasEthMax: 0.02, voteRateMaxPerCycle: 25,
  mintReppoMax: 100, mintGasEthMax: 0.05, horizonDays: 30, cadenceHours: 6, notes: 'x',
}

describe('OnboardingAnswersSchema / validateAnswers', () => {
  it('parses a good answer set', () => {
    expect(OnboardingAnswersSchema.parse(good).datanets[0].id).toBe('9')
  })
  it('validateAnswers returns ok:true for valid, ok:false+error for invalid', () => {
    expect(validateAnswers(good).ok).toBe(true)
    const bad = validateAnswers({ ...good, horizonDays: -1 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/horizon|number|positive|greater/i)
  })
})
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```ts
// src/onboarding/schema.ts
import { z } from 'zod'
import { Strictness } from '../config/schema.js'
import { buildStrategyConfig } from './build.js'
import type { OnboardingAnswers } from './types.js'

export const OnboardingAnswersSchema = z.object({
  datanets: z.array(z.object({
    id: z.string(),
    vote: z.boolean(),
    mint: z.boolean(),
    strictness: Strictness,
    adapter: z.string().optional(),
  })),
  lockReppo: z.number().nonnegative(),
  lockDurationDays: z.number().int().positive(),
  voteGasEthMax: z.number().nonnegative(),
  voteRateMaxPerCycle: z.number().int().nonnegative(),
  mintReppoMax: z.number().nonnegative(),
  mintGasEthMax: z.number().nonnegative(),
  horizonDays: z.number().int().positive(),
  cadenceHours: z.number().int().positive(),
  notes: z.string().default(''),
})

export type ValidateResult = { ok: true; answers: OnboardingAnswers } | { ok: false; error: string }

/** Validate raw answers two ways: shape (zod) + full StrategyConfig assembly. */
export function validateAnswers(raw: unknown): ValidateResult {
  const parsed = OnboardingAnswersSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  try {
    buildStrategyConfig(parsed.data) // throws if the assembled config is invalid
    return { ok: true, answers: parsed.data }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
```

- [ ] **Step 4: Run → pass (2).** Commit: `feat(onboarding): OnboardingAnswers zod schema + validateAnswers`

---

### Task 3: Conversational agent

**Files:** Create `src/onboarding/agent.ts`, `src/onboarding/agent.test.ts`

- [ ] **Step 1: Failing test** (tools + a mock-model loop; uses `ai/test`)

```ts
// src/onboarding/agent.test.ts
import { describe, it, expect, vi } from 'vitest'
import { MockLanguageModelV1 } from 'ai/test'
import { runConversationalOnboarding, type OnboardingAgentDeps } from './agent.js'
import type { Prompter } from './types.js'

const validAnswers = {
  datanets: [{ id: '9', vote: true, mint: true, strictness: 'conservative', adapter: 'hyperliquid' }],
  lockReppo: 0, lockDurationDays: 30, voteGasEthMax: 0.02, voteRateMaxPerCycle: 25,
  mintReppoMax: 100, mintGasEthMax: 0.05, horizonDays: 30, cadenceHours: 6, notes: 'picky',
}
const silentPrompter: Prompter = { ask: async () => 'ok', info: () => {} }

function deps(model: OnboardingAgentDeps['model']): OnboardingAgentDeps {
  return {
    model,
    prompter: silentPrompter,
    listDatanets: vi.fn(async () => [{ id: '9', name: 'TradingGym AI', status: 'ACTIVE', description: 'HL', accessFeeReppo: 50, emissionsPerEpochReppo: 500, upVoteVolume: 1, downVoteVolume: 1 }]),
    getDatanetDetails: vi.fn(async () => ({ datanetId: '9', name: 'TradingGym AI', goal: 'g', publisherSpec: 'p', voterRubric: 'v', canVote: true, canMint: true, status: 'ACTIVE', economics: { accessFeeReppo: 50, emissionsPerEpochReppo: 500, upVoteVolume: 1, downVoteVolume: 1, nativeTokenSymbol: 'REPPO' } })),
  }
}

describe('runConversationalOnboarding', () => {
  it('returns the answers the model passes to the finalize tool', async () => {
    let call = 0
    const model = new MockLanguageModelV1({
      doGenerate: async () => {
        call++
        if (call === 1) {
          return {
            finishReason: 'tool-calls', usage: { promptTokens: 1, completionTokens: 1 }, rawCall: { rawPrompt: null, rawSettings: {} },
            toolCalls: [{ toolCallType: 'function', toolCallId: 't1', toolName: 'finalize', args: JSON.stringify(validAnswers) }],
          }
        }
        return { finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 }, rawCall: { rawPrompt: null, rawSettings: {} }, text: 'All set.' }
      },
    })
    const answers = await runConversationalOnboarding(deps(model))
    expect(answers.datanets[0].id).toBe('9')
    expect(answers.notes).toBe('picky')
  })
})
```

> NOTE: `MockLanguageModelV1`'s exact `doGenerate` return shape can vary slightly across `ai@4.x` minors. If the literal above mismatches the installed types, adapt the mock's return object to the installed `ai/test` types (keep the intent: step 1 emits a `finalize` tool call with `validAnswers`, step 2 returns stop+text). If the mock-loop proves too fiddly, instead test the finalize path by calling the built tool's `execute` directly (`buildOnboardingTools` → `tools.finalize.execute(validAnswers)` sets the captured answers) plus a `list_datanets.execute()` returning the injected catalog — that still proves tool wiring + finalize capture. Document whichever path you took.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```ts
// src/onboarding/agent.ts
import { generateText, tool, type LanguageModel, type CoreMessage } from 'ai'
import { z } from 'zod'
import type { Prompter, OnboardingAnswers } from './types.js'
import type { DatanetSummary } from '../reppo/listDatanets.js'
import type { DatanetRubric } from '../rubric/types.js'
import { OnboardingAnswersSchema, validateAnswers } from './schema.js'

export interface OnboardingAgentDeps {
  model: LanguageModel
  prompter: Prompter
  listDatanets(): Promise<DatanetSummary[]>
  getDatanetDetails(datanetId: string): Promise<DatanetRubric | { error: string }>
}

const SYSTEM = `You are Orquestra's onboarding assistant. Help the operator configure a self-hosted Reppo agent node: which datanets to VOTE and/or MINT on, how much REPPO to lock (veREPPO voting power) and for how long, budget caps (vote gas, votes/cycle, mint REPPO, mint gas), the budget horizon, and how often the node runs (cadence hours).
Use list_datanets to answer "what's available" with live data. Use get_datanet_details to explain what a datanet wants and whether minting is possible.
IMPORTANT: minting requires a data adapter. Today only datanet 9 (TradingGym AI) has one ("hyperliquid"); for every other datanet set mint=false (vote-only).
You may RECOMMEND choices from the catalog economics, but always confirm each decision with the operator before finishing. When the operator confirms, call finalize with the complete structured answers. Keep messages short.`

/** Build the agent's tools. onFinalize is called with validated answers when the model finalizes. */
export function buildOnboardingTools(deps: OnboardingAgentDeps, onFinalize: (a: OnboardingAnswers) => void) {
  return {
    list_datanets: tool({
      description: 'List active Reppo datanets (id, name, description, fees, emissions, vote volume).',
      parameters: z.object({}),
      execute: async () => ({ datanets: await deps.listDatanets() }),
    }),
    get_datanet_details: tool({
      description: "Get a datanet's goal + publisher/voter rubric + capability.",
      parameters: z.object({ datanetId: z.string() }),
      execute: async ({ datanetId }) => deps.getDatanetDetails(datanetId),
    }),
    finalize: tool({
      description: 'Validate + save the operator-confirmed strategy. Call only after the operator confirms.',
      parameters: OnboardingAnswersSchema,
      execute: async (answers) => {
        const res = validateAnswers(answers)
        if (!res.ok) return { saved: false, error: res.error }
        onFinalize(res.answers)
        return { saved: true }
      },
    }),
  }
}

/** Run the conversational onboarding to completion; returns the finalized answers. */
export async function runConversationalOnboarding(deps: OnboardingAgentDeps): Promise<OnboardingAnswers> {
  let finalAnswers: OnboardingAnswers | null = null
  const tools = buildOnboardingTools(deps, (a) => { finalAnswers = a })
  const messages: CoreMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'Begin onboarding. Greet me briefly and ask what I want my node to do.' },
  ]
  deps.prompter.info('orquestra onboarding — chat with the assistant. Type "quit" to cancel.\n')

  while (!finalAnswers) {
    const res = await generateText({ model: deps.model, tools, messages, maxSteps: 6 })
    messages.push(...res.response.messages)
    if (res.text.trim()) deps.prompter.info(`\nassistant: ${res.text}\n`)
    if (finalAnswers) break
    const reply = (await deps.prompter.ask('you')).trim()
    if (/^(quit|exit|cancel)$/i.test(reply)) throw new Error('onboarding cancelled')
    messages.push({ role: 'user', content: reply })
  }
  return finalAnswers
}
```

- [ ] **Step 4: Run → pass.** Commit: `feat(onboarding): conversational agent with datanet tools + finalize`

---

### Task 4: Wire into main; remove structured wizard

**Files:** Modify `src/index.ts`; delete `src/onboarding/interview.ts` + `src/onboarding/interview.test.ts`; update `.env.example` + `Dockerfile` comment.

- [ ] **Step 1:** Delete the structured wizard: `git rm src/onboarding/interview.ts src/onboarding/interview.test.ts`

- [ ] **Step 2:** In `src/index.ts`, replace the `onboard()` body to use the conversational agent:

```ts
async function onboard(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true })
  const apiKey = process.env.LLM_API_KEY ?? ''
  if (!apiKey) {
    console.error('orquestra: onboarding needs an LLM key — set LLM_PROVIDER + LLM_API_KEY and re-run.')
    process.exitCode = 1
    return
  }
  const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider
  const model = resolveModel(provider, apiKey)
  const p = terminalPrompter()
  try {
    const answers = await runConversationalOnboarding({
      model,
      prompter: p,
      listDatanets: () => listDatanetsJson(),
      getDatanetDetails: async (id) => {
        try { return await getDatanetRubric(id) } catch (e) { return { error: (e as Error).message } }
      },
    })
    persistOnboarding(DATA_DIR, buildStrategyConfig(answers), answers.notes)
    p.info(`Saved strategy to ${DATA_DIR}. Run \`orquestra\` to start the node.`)
  } finally {
    p.close()
  }
}
```

Add imports at the top of `src/index.ts`: `import { runConversationalOnboarding } from './onboarding/agent.js'` and `import { listDatanetsJson } from './reppo/listDatanets.js'`. Remove the unused `import { runOnboarding } from './onboarding/interview.js'`. (`resolveModel`/`LlmProvider`/`getDatanetRubric`/`terminalPrompter`/`buildStrategyConfig`/`persistOnboarding` are already imported.)

- [ ] **Step 3:** `.env.example` — add under the LLM section: `# Onboarding is an LLM chat — an LLM key is REQUIRED to configure the node.` Update the `Dockerfile` comment: first run needs `-it` AND a valid `LLM_*` key (onboarding is conversational).

- [ ] **Step 4: Full suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: tests green (prior 82 − 6 removed interview + 2 listDatanets + 2 schema + agent test(s)); typecheck 0; build emits dist.

- [ ] **Step 5: Commit**

```bash
git add -A
git -c commit.gpgsign=false commit -m "feat(onboarding): wire conversational onboarding into main; drop structured wizard"
```

---

## Self-review (done while writing)

- **Spec coverage:** delivers the requested LLM-chat onboarding — the operator can ask "what datanets are available?" (the `list_datanets` tool returns the live catalog), the assistant recommends but the operator confirms, and `finalize` validates + the answers persist via the existing `buildStrategyConfig`/`persistOnboarding`. Conversational-only (the structured wizard is removed); requires an LLM key (guarded in `main`).
- **Mint-capability guard:** the system prompt tells the model only datanet 9 (hyperliquid adapter) can mint — others vote-only — matching the real adapter registry.
- **Testability:** catalog parser + answers validator are pure/unit-tested; the agent loop is tested with `MockLanguageModelV1` (with a documented fallback to direct tool-execute tests if the mock shape mismatches the installed SDK).
- **Security:** datanet/catalog content is data, not instructions; the finalize tool re-validates every field via zod + `buildStrategyConfig`, so the model cannot persist an out-of-schema or unsafe config.
- **No placeholders.** Cross-unit: deletes interview.ts/test; touches index.ts + .env.example + Dockerfile comment only.
