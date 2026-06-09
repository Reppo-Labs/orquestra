# Pipeline Guards & Dashboard Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the live node from wasting LLM inference and doomed transactions on inaccessible datanets, fix the pod-name length bug blocking minting, and surface failures on the dashboard.

**Architecture:** Three targeted guards in the existing cycle pipeline (skip-before-scoring access gate in `runCycle`, two-layer pod-name clamp, error-code decoding), plus a new server-side `/api/health` aggregation endpoint and three vanilla-HTML dashboard panels. No new dependencies, no framework.

**Tech Stack:** TypeScript (ESM, Node), vitest, zod, vanilla HTML/JS dashboard. Test with `npx vitest run <file>`; full suite `npm test`; types `npm run typecheck`.

**Spec:** `docs/superpowers/specs/2026-06-09-orquestra-pipeline-guards-and-dashboard-health-design.md`

**Branch:** `feat/pipeline-guards-dashboard-health` (already created; spec committed).

---

### Task 1: `skip` activity entries

**Files:**
- Modify: `src/dashboard/activityLog.ts:5-22` (the `ActivityEntry` interface)
- Test: `src/dashboard/activityLog.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the existing `describe` block in `src/dashboard/activityLog.test.ts` (match the file's existing style — it uses a tmp dir fixture):

```ts
it('round-trips a skip entry (kind skip, status skipped, reason)', () => {
  appendActivity(dir, {
    ts: '2026-06-09T00:00:00.000Z', cycleId: 'c1', kind: 'skip', datanetId: '2',
    reason: 'subnet access not granted (grant-access refused-budget: grant REPPO budget exhausted)',
    status: 'skipped',
  })
  const out = readActivity(dir, { limit: 10 })
  expect(out[0]).toMatchObject({ kind: 'skip', datanetId: '2', status: 'skipped' })
  expect(out[0].reason).toMatch(/subnet access not granted/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard/activityLog.test.ts`
Expected: FAIL — TypeScript error: `'skip'` not assignable to `kind`, `'skipped'` not assignable to `status` (vitest surfaces this as a transform/type error).

- [ ] **Step 3: Widen the unions**

In `src/dashboard/activityLog.ts` change two lines of the `ActivityEntry` interface:

```ts
  kind: 'vote' | 'mint' | 'claim' | 'skip'
```

```ts
  status: 'executed' | 'refused-budget' | 'error' | 'skipped'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard/activityLog.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/activityLog.ts src/dashboard/activityLog.test.ts
git commit -m "feat(activity): add skip kind + skipped status"
```

---

### Task 2: Access gate in `runCycle` (skip before scoring)

**Files:**
- Modify: `src/runtime/cycle.ts:42-48` (`DatanetReport`) and `:80-91` (grant block)
- Test: `src/runtime/cycle.test.ts`

Background: the grant block currently logs a failed grant and proceeds; with `grantReppoMax: 0` the refusal is persistent, so the node LLM-scores pods and submits votes that always fail `VOTER_LACKS_SUBNET_ACCESS`.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('runCycle', ...)` block in `src/runtime/cycle.test.ts` (the file's `deps()` factory and `rubric()` helper are already there — note `deps()` omits `grantedSubnets`/`recordGrant` by default, which is the "gate disabled" case):

```ts
it('skips vote AND mint when subnet access is required and the grant is refused (no scoring waste)', async () => {
  const executeGrantAccess = vi.fn(async () => ({
    ok: false as const, status: 'refused-budget' as const,
    detail: 'grant REPPO budget exhausted (set budget.grantReppoMax to enable subnet-access grants)',
  }))
  const d = deps({
    executor: {
      executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
      executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
      executeGrantAccess,
    } as unknown as CycleDeps['executor'],
    grantedSubnets: async () => new Set<string>(),
    recordGrant: vi.fn(),
  })
  const report = await runCycle(config, 'cycle-skip', d)

  // the expensive paths were never entered
  expect(d.getPodsAndFilter).not.toHaveBeenCalled()
  expect((d.executor.executeVote as any).mock.calls.length).toBe(0)
  expect((d.executor.executeMint as any).mock.calls.length).toBe(0)

  // the skip is visible in the report and the activity log
  const d9 = report.datanets.find((r) => r.datanetId === '9')!
  expect(d9.skipped).toMatch(/subnet access not granted/)
  const skips = (d.recordActivity as ReturnType<typeof vi.fn>).mock.calls
    .map((c: unknown[]) => c[0] as { kind: string; datanetId: string; status: string; reason?: string })
    .filter((e) => e.kind === 'skip')
  expect(skips.length).toBe(2) // datanets 9 and 2, one entry each per cycle
  expect(skips[0].status).toBe('skipped')
  expect(skips[0].reason).toMatch(/grant-access refused-budget/)
})

it('does not skip when access is already granted, when the grant succeeds, or when the rubric has no subnetUuid', async () => {
  // already granted → proceeds
  const granted = deps({
    executor: {
      executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
      executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
      executeGrantAccess: vi.fn(),
    } as unknown as CycleDeps['executor'],
    grantedSubnets: async () => new Set(['9', '2']),
    recordGrant: vi.fn(),
  })
  let report = await runCycle(config, 'g1', granted)
  expect(report.datanets.every((r) => r.skipped === undefined)).toBe(true)
  expect(granted.getPodsAndFilter).toHaveBeenCalled()

  // grant succeeds this cycle → proceeds immediately
  const grantsNow = deps({
    executor: {
      executeVote: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xv' })),
      executeMint: vi.fn(async () => ({ ok: true, status: 'executed', txHash: '0xm' })),
      executeGrantAccess: vi.fn(async () => ({ ok: true as const, status: 'executed' as const, txHash: '0xg' })),
    } as unknown as CycleDeps['executor'],
    grantedSubnets: async () => new Set<string>(),
    recordGrant: vi.fn(),
  })
  report = await runCycle(config, 'g2', grantsNow)
  expect(report.datanets.every((r) => r.skipped === undefined)).toBe(true)

  // no subnetUuid (pre-subnet metadata) → gate not applicable, proceeds
  const noSubnet = deps({
    getRubric: vi.fn(async (id: string) => rubric({ datanetId: id, subnetUuid: '' })),
    grantedSubnets: async () => new Set<string>(),
    recordGrant: vi.fn(),
  })
  report = await runCycle(config, 'g3', noSubnet)
  expect(report.datanets.every((r) => r.skipped === undefined)).toBe(true)
  expect(noSubnet.getPodsAndFilter).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/runtime/cycle.test.ts`
Expected: FAIL — first test: `getPodsAndFilter` *was* called, `d9.skipped` undefined. Second test should pass already (it pins current behavior); keep it as a regression guard.

- [ ] **Step 3: Implement the gate**

In `src/runtime/cycle.ts`:

(a) Add the field to `DatanetReport`:

```ts
export interface DatanetReport {
  datanetId: string
  votes: ExecResult[]
  mints: ExecResult[]
  /** set when this datanet was skipped due to an error (rubric unavailable, RPC failure, …). */
  error?: string
  /** set when vote/mint were intentionally skipped (e.g. subnet access not granted). */
  skipped?: string
}
```

(b) Replace the grant block (currently cycle.ts:73-91, the comment + `if` statement) with:

```ts
      // Subnet access is a one-time prerequisite for both voting and minting. Grant it
      // once per subnet (cached) before either. A datanet whose metadata predates the
      // subnet model (empty subnetUuid) can't be granted and is left to proceed/fail
      // naturally.
      // grant-access is keyed by the INTEGER datanet id (the `--datanet <id>` arg), NOT the
      // subnet uuid; subnetUuid presence just signals the datanet uses the access model.
      // Without access every vote/mint reverts on-chain (VOTER_LACKS_SUBNET_ACCESS) — but
      // only AFTER paying for pod fetching and LLM scoring. So a failed/refused grant
      // skips the datanet for this cycle instead of proceeding; it resumes automatically
      // the cycle after a grant succeeds (e.g. operator raises budget.grantReppoMax).
      if ((policy.vote || policy.mint) && rubric.subnetUuid && deps.grantedSubnets && deps.recordGrant) {
        const granted = await deps.grantedSubnets()
        if (!granted.has(datanetId)) {
          const gr = await deps.executor.executeGrantAccess(datanetId)
          if (gr.status === 'executed') {
            deps.recordGrant(datanetId)
            console.error(`orquestra: datanet ${datanetId} — granted access`)
          } else {
            const skipped = `subnet access not granted (grant-access ${gr.status}: ${gr.detail ?? ''})`
            console.error(`orquestra: datanet ${datanetId} skipped — ${skipped}`)
            deps.recordActivity({
              ts: new Date().toISOString(), cycleId, kind: 'skip', datanetId,
              reason: skipped, status: 'skipped',
            })
            datanets.push({ datanetId, votes, mints, skipped })
            continue
          }
        }
      }
```

Note the `continue` is inside the per-datanet `for` loop and before any pod fetching — that is the entire point.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/runtime/cycle.test.ts`
Expected: PASS — all existing tests (grant caching, isolation, claims) must still pass; the default `deps()` has no `grantedSubnets`, so legacy behavior is untouched.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/cycle.ts src/runtime/cycle.test.ts
git commit -m "feat(cycle): skip datanet before scoring when subnet access not granted"
```

---

### Task 3: `clampPodName` helper

**Files:**
- Create: `src/adapter/podName.ts`
- Test: `src/adapter/podName.test.ts`

The reppo CLI rejects `--pod-name` over 50 chars (`INVALID_POD_NAME: must be ≤50 chars; got 144` — live failure). One shared helper, used by the gdelt adapter (root cause) and `selectMints` (safety net).

- [ ] **Step 1: Write the failing tests**

Create `src/adapter/podName.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { clampPodName, POD_NAME_MAX } from './podName.js'

describe('clampPodName', () => {
  it('passes short names through unchanged', () => {
    expect(clampPodName('HL perps, 0x9984..95ba: 9 trades')).toBe('HL perps, 0x9984..95ba: 9 trades')
  })

  it('clamps the real 144-char live failure to ≤50 at a word boundary', () => {
    const long = "The US has added major Chinese firms including BYD and NIO to a 'Chinese military companies' blacklist, prompting formal objection from Beijing."
    const out = clampPodName(long)
    expect(out.length).toBeLessThanOrEqual(POD_NAME_MAX)
    expect(out).toBe('The US has added major Chinese firms including')
  })

  it('hard-cuts a name with no usable word boundary', () => {
    const out = clampPodName('x'.repeat(120))
    expect(out).toBe('x'.repeat(50))
  })

  it('normalizes whitespace before measuring', () => {
    expect(clampPodName('  a   b  ')).toBe('a b')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/adapter/podName.test.ts`
Expected: FAIL — cannot resolve `./podName.js`.

- [ ] **Step 3: Implement**

Create `src/adapter/podName.ts`:

```ts
// src/adapter/podName.ts

/** The reppo CLI rejects `--pod-name` longer than this (INVALID_POD_NAME). */
export const POD_NAME_MAX = 50

/** Clamp a pod name to the CLI limit. Cuts at a word boundary when one exists
 *  in the back half of the budget (avoids mid-word chops); otherwise hard-cuts.
 *  No ellipsis — the CLI limit counts characters and the full text survives in
 *  the pod description. */
export function clampPodName(name: string, max = POD_NAME_MAX): string {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/adapter/podName.test.ts`
Expected: PASS (4 tests). If the word-boundary expectation in test 2 is off by a word, fix the TEST to the actual ≤50 boundary output — the invariant that matters is `length ≤ 50` + whole words.

- [ ] **Step 5: Commit**

```bash
git add src/adapter/podName.ts src/adapter/podName.test.ts
git commit -m "feat(adapter): clampPodName helper for the CLI 50-char limit"
```

---

### Task 4: Safety-net clamp in `selectMints`

**Files:**
- Modify: `src/minter/select.ts` (import + line 42)
- Test: `src/minter/select.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/minter/select.test.ts` (reuse the file's existing `cand()` factory and opts pattern):

```ts
it('clamps an over-long candidate podName to 50 chars in the intent', async () => {
  const long = cand('klong')
  long.podName = 'A '.repeat(60) + 'end' // 123 chars
  const intents = await selectMints('9', [long], rubric, opts())
  expect(intents).toHaveLength(1)
  expect(intents[0].podName.length).toBeLessThanOrEqual(50)
})
```

(If the file's helpers are named differently, follow its local pattern — the assertion is the contract: `intent.podName.length ≤ 50`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/minter/select.test.ts`
Expected: FAIL — podName length is 123.

- [ ] **Step 3: Implement**

In `src/minter/select.ts`, add the import and clamp at intent construction:

```ts
import { clampPodName } from '../adapter/podName.js'
```

and in the `intents.push({...})` call change:

```ts
      podName: clampPodName(c.podName), podDescription: c.podDescription, datasetPath,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/minter/select.test.ts`
Expected: PASS (all tests — existing short names are unchanged by the clamp).

- [ ] **Step 5: Commit**

```bash
git add src/minter/select.ts src/minter/select.test.ts
git commit -m "fix(minter): clamp podName to CLI 50-char limit at intent construction"
```

---

### Task 5: gdelt short title (root cause)

**Files:**
- Modify: `src/adapter/gdelt/claim.ts` (schema :18-28, candidate :78-89, prompt :102-108)
- Test: `src/adapter/gdelt/claim.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/adapter/gdelt/claim.test.ts` (the file already stubs `deps.generate`; follow its existing fixture style for rubric/strategy):

```ts
it('uses the LLM short title as podName, clamped to 50 chars', async () => {
  const cands = await synthesizeClaims(articles, rubric, '2', strategy, {
    generate: async () => ({
      claims: [{
        claim: 'A long falsifiable claim that would blow past the CLI pod-name limit if used directly as the name',
        title: 'US blacklists BYD and NIO over military links',
        verdict: 'credible', confidence: 8, importance: 9,
        rationale: 'r', sources: ['https://example.com/a'],
      }],
    }),
  })
  expect(cands[0].podName).toBe('US blacklists BYD and NIO over military links')
})

it('falls back to the clamped claim when the model omits the title', async () => {
  const longClaim = 'The US has added major Chinese firms including BYD and NIO to a military blacklist prompting formal objection from Beijing'
  const cands = await synthesizeClaims(articles, rubric, '2', strategy, {
    generate: async () => ({
      claims: [{
        claim: longClaim,
        verdict: 'credible', confidence: 8, importance: 9,
        rationale: 'r', sources: ['https://example.com/a'],
      }],
    }),
  })
  expect(cands[0].podName.length).toBeLessThanOrEqual(50)
  expect(longClaim.startsWith(cands[0].podName)).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/adapter/gdelt/claim.test.ts`
Expected: FAIL — first: type error or podName equals full claim; second: podName length > 50.

- [ ] **Step 3: Implement**

In `src/adapter/gdelt/claim.ts`:

(a) Import the helper:

```ts
import { clampPodName } from '../podName.js'
```

(b) Add `title` to `ClaimSchema` (after `claim`). Optional + generous max so a model overrun degrades to the clamp instead of failing schema validation and dropping the whole batch:

```ts
    claim: z.string().min(1).max(200),
    title: z.string().min(1).max(120).optional(),
```

(c) Use it for `podName` (claim.ts:80):

```ts
      podName: clampPodName(c.title ?? c.claim),
```

(d) Ask for it in the prompt — in `buildSynthesisPrompt`, extend the final instruction sentence:

```ts
    `For each, synthesize a falsifiable claim, a short headline title (max 50 characters, used as the pod name), ` +
    `a verdict (credible|likely|disputed|exaggerated), a confidence 1-10, ` +
    `an importance 1-10, an optional timeframe, a one-line rationale, and the source url(s) you used.`
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/adapter/gdelt/claim.test.ts`
Expected: PASS (all — existing tests unaffected: `title` is optional and existing fixtures omit it, falling back to the clamped claim, which for their short claims is the claim itself).

- [ ] **Step 5: Commit**

```bash
git add src/adapter/gdelt/claim.ts src/adapter/gdelt/claim.test.ts
git commit -m "feat(gdelt): LLM short title as pod name, clamped fallback to claim"
```

---

### Task 6: Health aggregation (`buildHealth`)

**Files:**
- Create: `src/dashboard/health.ts`
- Test: `src/dashboard/health.test.ts`

Pure function over `ActivityEntry[]` (newest-first, as `readActivity` returns) → per-datanet counts, top error codes, last skip reason. Server-side so it's unit-testable and `index.html` stays dumb.

- [ ] **Step 1: Write the failing tests**

Create `src/dashboard/health.test.ts`. The error-detail fixtures are copied from real live failures:

```ts
import { describe, it, expect } from 'vitest'
import { buildHealth, extractErrorCode } from './health.js'
import type { ActivityEntry } from './activityLog.js'

const LACKS_ACCESS = 'Command failed: reppo vote --pod 922 --like --votes 8 — {"error":{"code":"VOTER_LACKS_SUBNET_ACCESS","message":"Vote tx failed to submit","hint":"Voter lacks subnet access."}}'
const BAD_NAME = 'Command failed: reppo mint-pod --datanet 2 — {"error":{"code":"INVALID_POD_NAME","message":"--pod-name must be ≤50 chars; got 144."}}'

const e = (over: Partial<ActivityEntry>): ActivityEntry => ({
  ts: '2026-06-09T00:00:00.000Z', cycleId: 'c1', kind: 'vote', datanetId: '2',
  status: 'executed', ...over,
})

describe('extractErrorCode', () => {
  it('pulls the CLI error code out of a command-failure detail', () => {
    expect(extractErrorCode(LACKS_ACCESS)).toBe('VOTER_LACKS_SUBNET_ACCESS')
    expect(extractErrorCode(BAD_NAME)).toBe('INVALID_POD_NAME')
  })
  it('buckets unparseable/missing details as UNKNOWN', () => {
    expect(extractErrorCode('something exploded')).toBe('UNKNOWN')
    expect(extractErrorCode(undefined)).toBe('UNKNOWN')
  })
})

describe('buildHealth', () => {
  it('counts by datanet × kind × status and ranks error codes', () => {
    const report = buildHealth([
      e({ kind: 'vote', status: 'error', detail: LACKS_ACCESS }),
      e({ kind: 'vote', status: 'error', detail: LACKS_ACCESS }),
      e({ kind: 'mint', status: 'error', detail: BAD_NAME }),
      e({ kind: 'vote', status: 'executed', datanetId: '9', txHash: '0x1' }),
      e({ kind: 'vote', status: 'refused-budget', datanetId: '9' }),
    ])
    const d2 = report.datanets.find((d) => d.datanetId === '2')!
    expect(d2.votes).toEqual({ executed: 0, refused: 0, error: 2 })
    expect(d2.mints).toEqual({ executed: 0, refused: 0, error: 1 })
    expect(d2.topErrors[0]).toEqual({ code: 'VOTER_LACKS_SUBNET_ACCESS', count: 2 })
    expect(d2.topErrors[1]).toEqual({ code: 'INVALID_POD_NAME', count: 1 })
    const d9 = report.datanets.find((d) => d.datanetId === '9')!
    expect(d9.votes).toEqual({ executed: 1, refused: 1, error: 0 })
  })

  it('surfaces the most recent skip reason (entries arrive newest-first)', () => {
    const report = buildHealth([
      e({ kind: 'skip', status: 'skipped', reason: 'newest reason' }),
      e({ kind: 'skip', status: 'skipped', reason: 'older reason' }),
    ])
    const d2 = report.datanets.find((d) => d.datanetId === '2')!
    expect(d2.skips).toBe(2)
    expect(d2.lastSkipReason).toBe('newest reason')
  })

  it('handles an empty log', () => {
    expect(buildHealth([])).toEqual({ entriesScanned: 0, datanets: [] })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/dashboard/health.test.ts`
Expected: FAIL — cannot resolve `./health.js`.

- [ ] **Step 3: Implement**

Create `src/dashboard/health.ts`:

```ts
// src/dashboard/health.ts
import type { ActivityEntry } from './activityLog.js'

export interface KindCounts { executed: number; refused: number; error: number }
export interface DatanetHealth {
  datanetId: string
  votes: KindCounts
  mints: KindCounts
  claims: KindCounts
  skips: number
  /** error codes across all kinds, desc by count. */
  topErrors: { code: string; count: number }[]
  /** most recent skip reason (the newest entry wins). */
  lastSkipReason?: string
}
export interface HealthReport { entriesScanned: number; datanets: DatanetHealth[] }

/** Extract the reppo CLI error code from an entry detail. The CLI embeds
 *  `{"error":{"code":"..."}}` inside a longer "Command failed: …" message, so a
 *  tolerant regex beats JSON.parse here. Unparseable → UNKNOWN. */
export function extractErrorCode(detail?: string): string {
  const m = detail?.match(/"code"\s*:\s*"([A-Za-z0-9_]+)"/)
  return m ? m[1] : 'UNKNOWN'
}

const counts = (): KindCounts => ({ executed: 0, refused: 0, error: 0 })

/** Aggregate activity (newest-first, as readActivity returns) into per-datanet
 *  health: vote/mint/claim outcome counts, skip count + latest reason, top errors. */
export function buildHealth(entries: ActivityEntry[]): HealthReport {
  const nets = new Map<string, DatanetHealth>()
  const errCounts = new Map<string, Map<string, number>>()
  const net = (id: string): DatanetHealth => {
    let n = nets.get(id)
    if (!n) { n = { datanetId: id, votes: counts(), mints: counts(), claims: counts(), skips: 0, topErrors: [] }; nets.set(id, n) }
    return n
  }
  for (const e of entries) {
    const n = net(e.datanetId)
    if (e.kind === 'skip') {
      n.skips++
      if (n.lastSkipReason === undefined) n.lastSkipReason = e.reason // first seen = newest
      continue
    }
    const bucket = e.kind === 'vote' ? n.votes : e.kind === 'mint' ? n.mints : n.claims
    if (e.status === 'executed') bucket.executed++
    else if (e.status === 'refused-budget') bucket.refused++
    else if (e.status === 'error') {
      bucket.error++
      const code = extractErrorCode(e.detail)
      const m = errCounts.get(e.datanetId) ?? new Map<string, number>()
      m.set(code, (m.get(code) ?? 0) + 1)
      errCounts.set(e.datanetId, m)
    }
  }
  for (const [id, m] of errCounts) {
    net(id).topErrors = [...m.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
  }
  return {
    entriesScanned: entries.length,
    datanets: [...nets.values()].sort((a, b) => a.datanetId.localeCompare(b.datanetId, undefined, { numeric: true })),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dashboard/health.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/health.ts src/dashboard/health.test.ts
git commit -m "feat(dashboard): health aggregation (counts, error codes, skip reasons)"
```

---

### Task 7: `GET /api/health` endpoint

**Files:**
- Modify: `src/dashboard/server.ts:7-10` (imports) and `:41-49` (routes)
- Test: `src/dashboard/server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/dashboard/server.test.ts` (the `beforeEach` already appends one executed vote for datanet 9):

```ts
it('/api/health aggregates activity into per-datanet counts', async () => {
  appendActivity(dir, {
    ts: 't2', cycleId: 'c2', kind: 'skip', datanetId: '2',
    reason: 'subnet access not granted (grant-access refused-budget: grant REPPO budget exhausted)',
    status: 'skipped',
  })
  const r = await get('/api/health')
  expect(r.status).toBe(200)
  const body = JSON.parse(r.body)
  const d9 = body.datanets.find((d: { datanetId: string }) => d.datanetId === '9')
  expect(d9.votes.executed).toBe(1)
  const d2 = body.datanets.find((d: { datanetId: string }) => d.datanetId === '2')
  expect(d2.skips).toBe(1)
  expect(d2.lastSkipReason).toMatch(/subnet access not granted/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard/server.test.ts`
Expected: FAIL — 404 on `/api/health`.

- [ ] **Step 3: Implement**

In `src/dashboard/server.ts` add the import:

```ts
import { buildHealth } from './health.js'
```

and the route (next to the other `/api/*` routes in `handle`):

```ts
    if (url === '/api/health') { json(res, 200, buildHealth(readActivity(dataDir, { limit: 5000 }))); return }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard/server.test.ts`
Expected: PASS (all, including the existing 404 test).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.ts src/dashboard/server.test.ts
git commit -m "feat(dashboard): /api/health endpoint"
```

---

### Task 8: Dashboard panels (cycle health, budget burn, idle datanets)

**Files:**
- Modify: `src/dashboard/index.html`

No unit test (vanilla HTML/JS); verified by the manual render check in Task 9. Keep the existing card/table style.

- [ ] **Step 1: Add CSS**

In the `<style>` block, after the `.err` rule (index.html:22), add:

```css
  .bar { background: #1c2230; border-radius: 4px; height: 8px; overflow: hidden; margin-top: 6px; }
  .bar > div { background: #6fb3e8; height: 100%; } .bar.hot > div { background: #e5707e; }
  .skipreason { color: #c9a86a; font-size: 12px; }
```

- [ ] **Step 2: Add HTML sections**

In `<main>`, after the `#cards` div (index.html:33) and before the "Claimable emissions" heading, insert:

```html
  <h2 style="font-size:15px">Cycle health</h2>
  <table id="healthTable"><thead><tr><th>Datanet</th><th>Votes ✓/⊘/✗</th><th>Mints ✓/⊘/✗</th><th>Skips</th><th>Top error</th></tr></thead><tbody></tbody></table>
  <div id="idle" style="margin-bottom:24px"></div>
  <h2 style="font-size:15px">Budget burn</h2>
  <div class="cards" id="budget"></div>
```

Also add `<option>skip</option>` to the `#kind` select (index.html:37) so skip entries are filterable in the activity feed.

- [ ] **Step 3: Add JS**

In `load()`, extend the parallel fetch (index.html:45-50) with health:

```js
  const [pnlRes, act, cfg, earn, health] = await Promise.all([
    fetch('/api/pnl').then(r => r.json()),
    fetch('/api/activity').then(r => r.json()),
    fetch('/api/config').then(r => r.json()),
    fetch('/api/earn').then(r => r.json()).catch(() => null),
    fetch('/api/health').then(r => r.json()).catch(() => null),
  ])
```

Then, after the `#cards` innerHTML assignment (index.html:66), add the three renderers:

```js
  // Cycle health: per-datanet outcome counts + dominant error code
  const hRows = (health?.datanets ?? [])
  const kc = (c) => `${c.executed}/${c.refused}/${c.error}`
  document.querySelector('#healthTable tbody').innerHTML = hRows.length
    ? hRows.map(d => `<tr><td>${d.datanetId}</td><td>${kc(d.votes)}</td><td>${kc(d.mints)}</td><td>${d.skips || ''}</td><td class="err">${d.topErrors[0] ? `${d.topErrors[0].code} × ${d.topErrors[0].count}` : ''}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">no activity yet</td></tr>'

  // Idle datanets: why a configured datanet is doing nothing
  const idle = hRows.filter(d => d.lastSkipReason)
  document.getElementById('idle').innerHTML = idle
    .map(d => `<div class="skipreason">datanet ${d.datanetId} idle — ${d.lastSkipReason}</div>`).join('')

  // Budget burn vs caps (current window, from the cycle snapshot)
  const b = snap?.budget, caps = b?.caps
  const bars = b ? [
    ['Vote gas (ETH)', b.voteGasSpentEth, caps.voteGasEthMax],
    ['Mint REPPO', b.mintReppoSpent, caps.mintReppoMax],
    ['Mint gas (ETH)', b.mintGasSpentEth, caps.mintGasEthMax],
    ['Claim gas (ETH)', b.claimGasSpentEth, caps.claimGasEthMax],
    ['Grant REPPO', b.grantReppoSpent ?? 0, caps.grantReppoMax ?? 0],
  ] : []
  document.getElementById('budget').innerHTML = bars.map(([k, spent, max]) => {
    const pct = max > 0 ? Math.min(100, Math.round(100 * spent / max)) : 0
    return `<div class="card"><div class="k">${k}</div><div class="v">${fmt(spent)} / ${fmt(max)}</div><div class="bar ${pct >= 80 ? 'hot' : ''}"><div style="width:${pct}%"></div></div></div>`
  }).join('')
```

Note: `snap` is already in scope in `load()` (`const p = pnlRes.pnl, snap = pnlRes.snapshot`) — guard with `snap?.budget` because the snapshot is null before the first cycle.

- [ ] **Step 4: Verify build copies the HTML and the suite still passes**

Run: `npm run build && npm test`
Expected: build OK (it `cp`s index.html into dist), all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/index.html
git commit -m "feat(dashboard): cycle health, budget burn, idle-datanet panels"
```

---

### Task 9: Verification, ops, and PR

**Files:** none created — investigation + deployment + PR.

- [ ] **Step 1: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS, no type errors.

- [ ] **Step 2: Manual dashboard render check against live data**

The repo's `orquestra-data/` is a live data dir with real failures in `activity-log.jsonl`. Start the built dashboard against it:

```bash
npm run build && node -e "import('./dist/dashboard/server.js').then(m => m.startDashboard('./orquestra-data', 7070).then(() => console.log('http://127.0.0.1:7070')))"
```

Open `http://127.0.0.1:7070` — expect the Cycle health table to show datanet 2 with a large `VOTER_LACKS_SUBNET_ACCESS` error count, and Budget burn bars rendered. Ctrl-C when done.

- [ ] **Step 3: Decode the `0x5dd58b8b` revert**

```bash
cast 4byte 0x5dd58b8b
```

Also check the reppo CLI / subnet contract ABI if cast finds nothing public. **If identified:** add a regex mapping in the reppo CLI error path (`src/reppo/cli.ts` — follow the `ACCESS_ALREADY_GRANTED` precedent in `src/wallet/executor.ts:48` for where friendly hints live) translating the selector to a human-readable hint, with a unit test mirroring the existing CLI error tests. **If not identifiable:** record findings in the PR description and move on — the access gate (Task 2) likely prevents the conditions that triggered it.

- [ ] **Step 4: Resolve live config drift**

The live node attempted votes on datanet 11 and a mint on 9; the repo config (`orquestra-data/strategy.config.json`) disables both. The config is loaded at process start, so the running node is almost certainly on a stale config. Find how the node is run (check for a Dockerfile / compose file / Railway config in the repo root and `docs/runbooks/`), then restart/redeploy it on the current config **with the new build**. Confirm the restart with the user before doing it — it's the live earning node.

- [ ] **Step 5: Live verification cycle**

After the restarted node completes one full cycle:

```bash
tail -50 orquestra-data/activity-log.jsonl | grep -c VOTER_LACKS_SUBNET_ACCESS
```

Expected: `0`. Also expect `"kind":"skip"` entries for datanet 2 (access gate working, no scoring waste), no datanet-11 votes, no datanet-9 mints, and the dashboard idle panel explaining why #2 is idle.

- [ ] **Step 6: Push and open PR**

```bash
git push -u origin feat/pipeline-guards-dashboard-health
gh pr create --title "feat: pipeline guards (access gate, pod-name clamp) + dashboard health panels" --body "$(cat <<'EOF'
## Summary
- Skip-before-scoring access gate in runCycle: datanets whose subnet access can't be granted are skipped before pod fetching/LLM scoring (kills the every-cycle VOTER_LACKS_SUBNET_ACCESS burn)
- Two-layer pod-name fix: gdelt emits a short title; selectMints clamps to the CLI 50-char limit (fixes INVALID_POD_NAME blocking datanet-2 mints)
- Dashboard: /api/health endpoint + cycle-health, budget-burn, and idle-datanet panels
- skip activity entries (kind: skip, status: skipped) make intentional idleness observable

Spec: docs/superpowers/specs/2026-06-09-orquestra-pipeline-guards-and-dashboard-health-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** 1.1 → Tasks 1–2; 1.2 → Tasks 3–5; 1.3 → Task 9 steps 3–4; 1.4 → embedded TDD steps + Task 9 step 5; 2.1 → Tasks 6–7; 2.2 → Task 8; 2.3 → Task 6 tests + Task 9 step 2. No gaps.
- **Type consistency:** `kind: 'skip'` / `status: 'skipped'` (Task 1) used identically in Tasks 2, 6, 7; `clampPodName`/`POD_NAME_MAX` (Task 3) imported in Tasks 4–5; `DatanetHealth.lastSkipReason`/`skips`/`topErrors` (Task 6) consumed by Task 8's JS.
- **Known judgment calls:** `title` max(120) not max(50) in zod so an overrun degrades to a clamp instead of dropping the whole claim batch; no ellipsis in the clamp (the CLI limit counts characters and the full text survives in the description).
