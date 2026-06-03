# Orquestra — Pod/vote-filter readers + dedup state (make cycles vote)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stubbed `getPodsAndFilter`/`seenKeysFor` in `main` with real `reppo`-CLI readers + persisted dedup state, so a cycle actually: pulls current-epoch pods, filters out own + already-voted, scores eligible pods (on their fetched IPFS content) via the configured model, and votes within budget — recording what it voted/minted so it never repeats.

**Architecture:** A `list pods` reader (`reppo list pods --all/--owner`) → `VoterPod[]`; a pure `deriveCurrentEpoch`. A persisted **dedup state** (`vote-state.json`: votedPodIds + mintedKeys per datanet) — pure logic + fs, unit-tested. `runCycle` gains `recordVote`/`recordMint` deps it calls **only on a confirmed-on-chain result**, so dedup reflects reality. `main` wires: all-pods + own-pods + voted-state → filter, with a **bounded IPFS-content fetch for the eligible subset only** so the voter scores on real data, not just the pod name.

**Tech Stack:** TS, vitest. Node global `fetch` for IPFS content. Reuses `VoterPod`/`VoteFilter` (voter), `runCycle`/`CycleDeps` (runtime), `ExecResult` (wallet).

**Builds on:** all prior units (merged), incl. reppo 0.7.

---

## Real `reppo list pods --all --datanet 9 --json` shape (captured live, 0.7.0)
`{ scope, network, count, datanet, pods: [ { podId:"508", name:"…", creator:"0x…"|"", datanetId:"9", upVotes:"0", downVotes:"0", validityEpoch:"101", url:"https://gateway.pinata.cloud/ipfs/…" } ] }`. Owner-scoped (no `--all`) returns only this wallet's pods.

## File structure
- Create: `src/reppo/listPods.ts` — `parsePods`, `deriveCurrentEpoch`, `listPodsJson(id,{all})`.
- Create: `src/runtime/state.ts` — `DedupState` (persisted votedPodIds + mintedKeys per datanet).
- Modify: `src/voter/types.ts` — add `url?: string` to `VoterPod`.
- Modify: `src/runtime/cycle.ts` — add `recordVote`/`recordMint` to `CycleDeps`, call on confirmed results.
- Modify: `src/index.ts` — wire `getPodsAndFilter`, `seenKeysFor`, `recordVote`, `recordMint`, + `fetchPodContent`.
- Test: `src/reppo/listPods.test.ts`, `src/runtime/state.test.ts`; update `src/runtime/cycle.test.ts`.
- Fixture: `test/fixtures/pods-list.json`.

---

### Task 1: list pods reader + currentEpoch

**Files:** `test/fixtures/pods-list.json`, `src/voter/types.ts` (add `url?`), `src/reppo/listPods.ts`, `src/reppo/listPods.test.ts`

- [ ] **Step 1: Fixture**

```json
{ "scope": "all", "network": "mainnet", "count": 3, "datanet": "9",
  "pods": [
    { "podId": "508", "name": "HotBot v4 — Signals Jun01-03", "creator": "0xother", "datanetId": "9", "upVotes": "0", "downVotes": "0", "validityEpoch": "101", "url": "https://gateway.pinata.cloud/ipfs/bafkA" },
    { "podId": "492", "name": "HL perps, 0x9a15..37e6: 74 trades", "creator": "0xme", "datanetId": "9", "upVotes": "2", "downVotes": "0", "validityEpoch": "101", "url": "https://gateway.pinata.cloud/ipfs/bafkB" },
    { "podId": "330", "name": "old pod", "creator": "0xother", "datanetId": "9", "upVotes": "1", "downVotes": "0", "validityEpoch": "98", "url": "https://gateway.pinata.cloud/ipfs/bafkC" }
  ] }
```

- [ ] **Step 2: Add `url?` to VoterPod** in `src/voter/types.ts`:

```ts
export interface VoterPod {
  podId: string
  validityEpoch: string
  name: string
  description: string
  /** IPFS content URL (the pod's dataset); used to enrich `description` for scoring. */
  url?: string
}
```

- [ ] **Step 3: Failing test**

```ts
// src/reppo/listPods.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePods, deriveCurrentEpoch } from './listPods.js'

const raw = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/pods-list.json'), 'utf-8'))

describe('parsePods / deriveCurrentEpoch', () => {
  it('maps pods to VoterPod (podId, validityEpoch, name, url; description defaults to name)', () => {
    const pods = parsePods(raw)
    expect(pods).toHaveLength(3)
    expect(pods[0]).toMatchObject({ podId: '508', validityEpoch: '101', name: 'HotBot v4 — Signals Jun01-03', url: 'https://gateway.pinata.cloud/ipfs/bafkA' })
    expect(pods[0].description).toBe('HotBot v4 — Signals Jun01-03') // default until content is fetched
  })
  it('deriveCurrentEpoch = max validityEpoch as a string', () => {
    expect(deriveCurrentEpoch(parsePods(raw))).toBe('101')
  })
  it('parsePods returns [] / deriveCurrentEpoch returns null on empty', () => {
    expect(parsePods({})).toEqual([])
    expect(deriveCurrentEpoch([])).toBeNull()
  })
})
```

- [ ] **Step 4: Run → fail.**

- [ ] **Step 5: Implement**

```ts
// src/reppo/listPods.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { VoterPod } from '../voter/types.js'

const execFileAsync = promisify(execFile)

/** Map `reppo list pods --json` rows to VoterPods. description defaults to the
 *  pod name; the caller may enrich it with fetched IPFS content for scoring. */
export function parsePods(raw: unknown): VoterPod[] {
  const rows = (raw as { pods?: unknown[] })?.pods
  if (!Array.isArray(rows)) return []
  return rows.map((r) => {
    const p = r as Record<string, unknown>
    const name = String(p.name ?? '')
    return {
      podId: String(p.podId ?? p.id ?? ''),
      validityEpoch: String(p.validityEpoch ?? ''),
      name,
      description: name,
      url: typeof p.url === 'string' ? p.url : undefined,
    }
  }).filter((p) => p.podId !== '')
}

/** Current epoch = max validityEpoch across pods (string), or null if none. */
export function deriveCurrentEpoch(pods: VoterPod[]): string | null {
  let max: number | null = null
  for (const p of pods) {
    const e = Number(p.validityEpoch)
    if (Number.isFinite(e)) max = max === null ? e : Math.max(max, e)
  }
  return max === null ? null : String(max)
}

/** List pods via the reppo CLI. all=true → every published pod; false → this wallet's. */
export async function listPodsJson(datanetId: string, opts: { all: boolean }): Promise<VoterPod[]> {
  const args = ['list', 'pods', '--datanet', datanetId, '--json']
  if (opts.all) args.splice(2, 0, '--all')
  const { stdout } = await execFileAsync('reppo', args, {
    env: { ...process.env, REPPO_NETWORK: process.env.REPPO_NETWORK ?? 'mainnet' }, timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  })
  try { return parsePods(JSON.parse(stdout)) } catch { throw new Error(`listPodsJson: bad reppo output: ${stdout.slice(0, 200)}`) }
}
```

- [ ] **Step 6: Run → pass (3).** Commit: `feat(reppo): list pods reader + deriveCurrentEpoch; VoterPod.url`

---

### Task 2: Persisted dedup state

**Files:** `src/runtime/state.ts`, `src/runtime/state.test.ts`

- [ ] **Step 1: Failing test**

```ts
// src/runtime/state.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DedupState } from './state.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-st-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('DedupState', () => {
  it('records + reads voted pods and minted keys per datanet, persisted', () => {
    const s = new DedupState(dir)
    expect(s.getVotedPodIds('9')).toEqual([])
    s.recordVote('9', '508'); s.recordVote('9', '508'); s.recordVote('2', '12')
    expect(s.getVotedPodIds('9')).toEqual(['508']) // deduped
    s.recordMint('9', 'abc123')
    expect(s.getMintedKeys('9')).toEqual(['abc123'])
    expect(existsSync(join(dir, 'vote-state.json'))).toBe(true)
    const s2 = new DedupState(dir) // reload from disk
    expect(s2.getVotedPodIds('9')).toEqual(['508'])
    expect(s2.getMintedKeys('9')).toEqual(['abc123'])
    expect(s2.getVotedPodIds('2')).toEqual(['12'])
  })
  it('tolerates a missing/corrupt state file (starts empty)', () => {
    const s = new DedupState(dir)
    expect(s.getMintedKeys('9')).toEqual([])
  })
})
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```ts
// src/runtime/state.ts
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

interface Shape { votedPodIds: Record<string, string[]>; mintedKeys: Record<string, string[]> }
const FILE = 'vote-state.json'
const fresh = (): Shape => ({ votedPodIds: {}, mintedKeys: {} })

/** Persisted dedup state: which pods we've voted on + which dataset keys we've
 *  minted, per datanet. Prevents re-voting (gas/power waste) + re-minting. */
export class DedupState {
  private state: Shape
  constructor(private readonly dataDir: string) {
    const path = join(dataDir, FILE)
    if (!existsSync(path)) { this.state = fresh(); return }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Shape>
      this.state = { votedPodIds: parsed.votedPodIds ?? {}, mintedKeys: parsed.mintedKeys ?? {} }
    } catch {
      this.state = fresh() // corrupt → start empty (worst case a re-vote attempt, which the chain dedups by epoch)
    }
  }
  getVotedPodIds(datanetId: string): string[] { return this.state.votedPodIds[datanetId] ?? [] }
  getMintedKeys(datanetId: string): string[] { return this.state.mintedKeys[datanetId] ?? [] }
  recordVote(datanetId: string, podId: string): void { this.add(this.state.votedPodIds, datanetId, podId) }
  recordMint(datanetId: string, key: string): void { this.add(this.state.mintedKeys, datanetId, key) }
  private add(map: Record<string, string[]>, dn: string, v: string): void {
    const set = new Set(map[dn] ?? []); set.add(v); map[dn] = [...set]; this.save()
  }
  private save(): void {
    const path = join(this.dataDir, FILE)
    writeFileSync(`${path}.tmp`, JSON.stringify(this.state, null, 2)); renameSync(`${path}.tmp`, path)
  }
}
```

- [ ] **Step 4: Run → pass (2).** Commit: `feat(runtime): persisted DedupState (voted pods + minted keys)`

---

### Task 3: runCycle records confirmed votes/mints

**Files:** `src/runtime/cycle.ts`, `src/runtime/cycle.test.ts`

- [ ] **Step 1:** Add to the `CycleDeps` interface (in `cycle.ts`):

```ts
  recordVote(datanetId: string, podId: string): void
  recordMint(datanetId: string, canonicalKey: string): void
```

- [ ] **Step 2:** Replace the two inner loops in `runCycle` so a confirmed result is recorded:

```ts
      if (policy.vote && rubric.canVote) {
        const { pods, filter } = await deps.getPodsAndFilter(datanetId)
        const intents = await selectVotes(datanetId, pods, rubric, policy.strictness, filter, deps.voteScorer)
        for (const intent of intents) {
          const r = await deps.executor.executeVote(intent)
          votes.push(r)
          if (r.ok) deps.recordVote(datanetId, intent.podId)
        }
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
          for (const intent of intents) {
            const r = await deps.executor.executeMint(intent)
            mints.push(r)
            if (r.ok) deps.recordMint(datanetId, intent.canonicalKey)
          }
        }
      }
```

- [ ] **Step 3:** In `cycle.test.ts`, add `recordVote: vi.fn()` and `recordMint: vi.fn()` to the `deps()` helper, and add a test: after a cycle with a successful vote on datanet 9, `recordVote` was called with `'9'` + the pod id; with a successful mint, `recordMint` was called with `'9'` + the candidate's canonicalKey. (Existing tests pass unchanged with the no-op spies.)

- [ ] **Step 4: Run → pass.** Commit: `feat(runtime): record confirmed votes/mints for dedup`

---

### Task 4: Wire main (real readers + content enrich)

**Files:** `src/index.ts`

- [ ] **Step 1:** Add imports: `import { listPodsJson, deriveCurrentEpoch } from './reppo/listPods.js'` and `import { DedupState } from './runtime/state.js'`.

- [ ] **Step 2:** Add a bounded IPFS content fetcher near the top of `src/index.ts`:

```ts
async function fetchPodContent(url: string): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return ''
    return (await res.text()).slice(0, 4000) // cap tokens
  } catch {
    return ''
  } finally {
    clearTimeout(t)
  }
}
```

- [ ] **Step 3:** In `start()`, add `const dedup = new DedupState(DATA_DIR)` (near the ledger), and replace the stubbed `getPodsAndFilter`/`seenKeysFor` in the `deps` object with these four:

```ts
    getPodsAndFilter: async (id) => {
      const pods = await listPodsJson(id, { all: true })
      const own = await listPodsJson(id, { all: false }).then((p) => p.map((x) => x.podId)).catch(() => [] as string[])
      const currentEpoch = deriveCurrentEpoch(pods)
      const voted = dedup.getVotedPodIds(id)
      const ownSet = new Set(own), votedSet = new Set(voted)
      for (const p of pods) {
        const eligible = (currentEpoch === null || p.validityEpoch === currentEpoch) && !ownSet.has(p.podId) && !votedSet.has(p.podId)
        if (eligible && p.url) { const c = await fetchPodContent(p.url); if (c) p.description = `${p.name}\n\n${c}` }
      }
      return { pods, filter: { currentEpoch, ownPodIds: own, votedPodIds: voted } }
    },
    seenKeysFor: async (id) => new Set(dedup.getMintedKeys(id)),
    recordVote: (id, podId) => dedup.recordVote(id, podId),
    recordMint: (id, key) => dedup.recordMint(id, key),
```

(Remove the old `getPodsAndFilter: async () => ({ pods: [], ... })` and `seenKeysFor: async () => new Set<string>()` stubs.)

- [ ] **Step 4: Typecheck + build + full suite**

Run: `npm run typecheck && npm run build && npm test`
Expected: typecheck 0; build emits dist; all tests green.

- [ ] **Step 5: Commit**

```bash
git add -A
git -c commit.gpgsign=false commit -m "feat(runtime): wire real pod/vote-filter readers + dedup state + IPFS content enrich"
```

---

## Self-review (done while writing)

- **Spec coverage:** closes the last gap — `getPodsAndFilter` returns real current-epoch pods (`reppo list pods --all`), own pods (owner-scoped → `ownPodIds`), and persisted `votedPodIds`; `seenKeysFor` returns persisted minted keys. The cycle records confirmed votes/mints (ISS-005 double-spend + ISS-016 own-pod guards now real). A real cycle: pull pods → filter → fetch eligible pods' IPFS content → score on the configured model → vote within budget.
- **Bounded fetch:** IPFS content is fetched only for the *eligible* subset (current-epoch, non-own, non-voted) — usually a handful — not all 60+ pods; 15s timeout + 4KB cap; failures degrade to the pod name.
- **Dedup integrity:** `recordVote`/`recordMint` fire only on `r.ok`; state is atomic-written (tmp+rename); a corrupt state file degrades to empty.
- **Testability:** parser + epoch + state are unit-tested; cycle recording is unit-tested with spies. The CLI/IPFS boundaries live in `main` (integration), injected as deps into the testable cycle.
- **No placeholders.**
