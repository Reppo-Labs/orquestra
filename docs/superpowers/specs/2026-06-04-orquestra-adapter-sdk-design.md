# Orquestra Adapter SDK — operator-installed npm packages — Design

**Date:** 2026-06-04
**Status:** Approved (design); pending implementation plan
**Goal:** Let an operator extend minting to new datanets by **installing third-party
adapter npm packages** and registering them in `strategy.config.json` — without
editing core. Formalize the `DatanetAdapter` contract, ship a registry/loader that
resolves built-in + operator-installed adapters, document an authoring guide, and
provide a contract-test harness. (Mechanism only — no new concrete adapter, no
published SDK package this iteration.)

---

## Problem

Today the adapter set is hardcoded. `src/index.ts` does
`const adapters = [createHyperliquidAdapter()]` and exposes
`getAdapter: (id) => adapters.find(a => a.id === id)`. Minting on any datanet other
than #9 requires editing core and rebuilding the image. The `DatanetAdapter`
interface also carries a `matches(datanetId, rubric)` method that is **dead in the
runtime path** — `cycle.ts` routes purely on the config's `datanets[id].adapter`
string via `getAdapter(adapterId)` and never calls `matches()`.

We want a stable extension seam: adapters distributed as npm packages the operator
explicitly installs and references in config, loaded at startup, with a documented
contract third parties can build against — all without touching the budget/signing
safety boundary.

## Decisions (locked during brainstorming)

1. **Distribution = operator-installed npm packages.** Adapters are npm packages the
   operator installs and names in config; loaded via dynamic `import()` at startup.
   Third parties can publish; the operator opts in per package. (Trade-off accepted:
   adapter code runs in-process — see Security.)
2. **Wiring = explicit registration block.** A top-level `adapters` map in
   `strategy.config.json` maps a registration id → `{ package, options }`. The
   registration id is the authoritative routing key; `datanets[id].adapter`
   references it. Decouples routing id from package name and gives each adapter a
   per-operator `options` bag passed to its factory.
3. **SDK scope = formalize + document in-repo; publish later.** Ship the loading
   mechanism, a stable documented `DatanetAdapter` contract, an in-repo contract-test
   harness, the hyperliquid worked example, and an authoring guide. Publishing a
   standalone `@reppo/orquestra-adapter-sdk` package is a fast-follow.
4. **Loading = startup-resolved registry (Approach A).** A new `adapter/registry.ts`
   builds the full adapter map once at startup; the cycle hot path is unchanged. A
   broken/missing adapter **warns and continues** (votes are never blocked by a mint
   adapter); startup logs a one-line summary of what loaded.
5. **Contract simplifications:** drop `matches()` from `DatanetAdapter`; the package's
   **default export** is the factory `(options) => DatanetAdapter` (`createAdapter`
   named export accepted as fallback); route by **registration key**, not
   `adapter.id`.

## Architecture

```
startup (src/index.ts)
  └─ buildAdapterRegistry(config, { builtins: [createHyperliquidAdapter()] })
        ├─ seed map with builtins        (keyed by adapter.id, e.g. "hyperliquid")
        ├─ for each config.adapters[regId] = { package, options }:
        │     await importPkg(package) → factory = mod.default ?? mod.createAdapter
        │     adapter = factory(options) → assertAdapterShape(adapter)
        │     map.set(regId, adapter)     (try/catch: on failure warn + skip)
        ├─ reference-integrity pass: warn for any mint:true datanet whose
        │     adapter id is not in the map (mint disabled for it; votes unaffected)
        └─ return { get(id) }            → wired into CycleDeps.getAdapter

per cycle (src/runtime/cycle.ts — UNCHANGED routing)
  policy.mint && policy.adapter && rubric.canMint
    → adapter = getAdapter(policy.adapter)
    → candidates = sanitizeCandidates(await adapter.discover(ctx))   (new hardening)
    → selectMints(...) → executor.executeMint(...)                    (budget enforced)
```

## Config schema (`src/config/schema.ts`)

Add an optional top-level `adapters` record (back-compat: absent → `{}`):

```jsonc
{
  "adapters": {
    "hl-pro": {
      "package": "@acme/orq-adapter-hl-pro",
      "options": { "apiKey": "...", "minVlm": 250000 }
    }
  },
  "datanets": {
    "12": { "vote": true, "mint": true, "strictness": "balanced", "adapter": "hl-pro" }
  }
}
```

- Zod:
  `adapters: z.record(z.string(), z.object({ package: z.string().min(1), options: z.unknown().optional() }).strict()).default({})`
- Built-in adapters need **no** registration entry: `datanets[id].adapter:
  "hyperliquid"` works with zero config.
- Reference integrity (datanet → adapter resolvable) is checked at **load time** in
  the registry builder (warn, don't crash), NOT via zod `superRefine` — built-in ids
  aren't known to the schema, and warn-and-continue is the desired behavior.

## The adapter contract (`src/adapter/types.ts` + public `src/adapter/sdk.ts`)

- Slimmed interface (drop `matches`):
  ```ts
  interface DatanetAdapter {
    id: string
    discover(ctx: AdapterContext): Promise<CandidatePod[]>
  }
  ```
- Unchanged: `CandidatePod { canonicalKey; podName; podDescription; dataset; selfScore? }`,
  `AdapterContext { datanetId; rubric; topN }`, `CandidateScorer`.
- Factory contract: `type AdapterFactory = (options: unknown) => DatanetAdapter`. The
  package's **default export** is the factory; `createAdapter` named export accepted
  as a fallback.
- `assertAdapterShape(x): asserts x is DatanetAdapter` — runtime guard
  (`typeof x.id === 'string' && typeof x.discover === 'function'`), since a loaded
  module is code, not zod-validatable data.
- `src/adapter/sdk.ts` re-exports the public surface (`DatanetAdapter`,
  `CandidatePod`, `AdapterContext`, `AdapterFactory`, `assertAdapterShape`,
  `runAdapterContract`) — the single import an external author targets, and the seam
  that becomes the published package later.

## The registry/loader (`src/adapter/registry.ts`)

```ts
export interface AdapterRegistry { get(id: string): DatanetAdapter | undefined }

export async function buildAdapterRegistry(
  config: StrategyConfig,
  deps: { builtins: DatanetAdapter[]; importPkg?: (pkg: string) => Promise<any> },
): Promise<AdapterRegistry>
```

- Seed the map with `builtins` keyed by `adapter.id`.
- For each `[regId, { package, options }]` in `config.adapters`, wrapped in try/catch:
  `mod = await importPkg(package)` → `factory = mod.default ?? mod.createAdapter` →
  `adapter = factory(options)` → `assertAdapterShape(adapter)` → `map.set(regId, adapter)`.
  On any failure: `console.error` a clear, package-attributed message and continue.
- `importPkg` is injected (default `(p) => import(p)`) so tests fake module loading
  with no real packages — the same DI pattern as `ReppoCli`/HL fetchers.
- **Collision policy:** a registration id equal to a built-in id → the registration
  **overrides** the built-in, with a warning (operator intent is explicit).
- **Reference-integrity pass:** for each datanet with `mint:true` and an `adapter`
  set whose id is absent from the map, warn:
  `datanet <id> references adapter "<adapter>" which failed to load / isn't registered — mint disabled this run`.
- Returns `{ get(id) }`. `src/index.ts` wires `getAdapter: (id) => registry.get(id)`
  and logs a startup summary:
  `orquestra: adapters — hyperliquid (built-in), hl-pro (@acme/...); 1 failed (see above)`.

## Changes to existing code

- **`src/adapter/types.ts`:** remove `matches` from `DatanetAdapter`; add
  `AdapterFactory`, `assertAdapterShape`.
- **`src/adapter/sdk.ts`** (new): public re-export surface.
- **`src/adapter/registry.ts`** (new): `buildAdapterRegistry` + reference-integrity.
- **`src/adapter/contract.ts`** (new): `runAdapterContract(adapter, sampleCtx)`.
- **`src/adapter/hyperliquid/index.ts`:** remove the `matches` method (keep
  `id: 'hyperliquid'`). Update `index.test.ts` (drop `matches` assertions).
- **`src/config/schema.ts`:** add the `adapters` record (default `{}`).
- **`src/index.ts`:** replace the hardcoded array + inline `getAdapter` with
  `buildAdapterRegistry(...)` + `registry.get`; add the startup summary log.
- **`src/runtime/cycle.ts`:** after `adapter.discover()`, run `sanitizeCandidates()`
  before dedup/scoring. Routing and isolation otherwise unchanged.
- **`sanitizeCandidates(candidates)`** (new helper in `adapter/`, reused by
  `cycle.ts`): filters out candidates with a missing/empty `canonicalKey` or absent
  `dataset`, warning per drop.
- **Docs:** `docs/adapters/authoring-guide.md` (new). `.env.example` + `README.md`
  gain a "only install adapter packages you trust" note.

## `sanitizeCandidates` (mint-path hardening)

Third-party `discover()` output is only as careful as its author. Before candidates
reach dedup/scoring/minting, drop the malformed ones:

- Keep a candidate iff `typeof canonicalKey === 'string' && canonicalKey !== ''` and
  `dataset != null`. (`podName`/`podDescription` default to empty strings downstream;
  `canonicalKey` and `dataset` are load-bearing for dedup + the minted body.)
- Each dropped candidate logs a warning naming the adapter/datanet. Never throws.

## Error handling (all warn-and-continue — the node must keep voting)

- Un-importable package / factory throws / wrong shape → caught in
  `buildAdapterRegistry`, logged, skipped; that datanet's mint is disabled (surfaced
  by the reference-integrity pass); votes + other adapters unaffected.
- `discover()` throws at cycle time → already isolated per-datanet in `cycle.ts`.
- Malformed candidates → removed by `sanitizeCandidates`.
- The startup summary makes partial-load state visible at a glance.

## Security

- **Adapter code runs in-process** and can read `process.env` (including
  `REPPO_PRIVATE_KEY`). The trust boundary is the operator's explicit `npm install` +
  registration choice. The node never *hands* an adapter the key, executor, or ledger,
  but cannot sandbox a malicious package. The authoring guide, `README.md`, and
  `.env.example` state plainly: **only install adapter packages you trust.**
- Adapter-sourced pod data remains **untrusted content** — the existing
  prompt-injection guard in the scorer system prompt still applies (candidates are
  scored through the same untrusted-data-aware path).
- Adapters **never sign**. Budget caps, dedup, and the pre-mint self-score gate are
  unchanged — a bad adapter wastes a cycle's compute, it cannot overspend.

## Testing

- **`registry.test.ts`:** seeds from builtins; loads a fake package via injected
  `importPkg`; asserts `options` reach the factory; warn-and-continue on
  import-failure / bad-shape / factory-throw; registration overrides a built-in;
  reference-integrity warning for an unknown/failed adapter. (DI fake `importPkg` —
  no real packages.)
- **`schema.test.ts`:** `adapters` parses; defaults to `{}` when absent; `.strict()`
  rejects unknown keys; `package` is required/non-empty.
- **`config/load`** round-trips a config containing `adapters`.
- **`hyperliquid/index.test.ts`:** updated to drop the `matches` assertions; discover
  behavior unchanged.
- **`contract.ts`:** `runAdapterContract` exercised against the hyperliquid adapter
  (the worked example).
- **`sanitizeCandidates`:** drops missing-`canonicalKey` / missing-`dataset`
  candidates, keeps valid ones, never throws.

## Out of scope (this iteration)

- Publishing `@reppo/orquestra-adapter-sdk` to npm (fast-follow; `src/adapter/sdk.ts`
  is the seam).
- Onboarding-wizard support for registering adapters — registration is a manual
  config edit, consistent with the manual `npm install`. Onboarding still offers only
  built-in adapters for mint.
- Sandboxing / isolating adapter code (inherent to the npm-package model).
- A second concrete adapter (mechanism-only this iteration).
- Re-introducing `matches()`-style auto-routing (explicit registration replaces it).
