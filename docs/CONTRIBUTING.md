# Contributing to Orquestra

Thanks for hacking on the node. This guide covers the local dev loop, the test
setup, and what CI checks before a PR can merge.

> Terminology in this repo is deliberate — **operator**, **node**, **strategy**,
> **bootstrap secrets**, **onboarding** all have reserved meanings. Read
> [`CONTEXT.md`](../CONTEXT.md) before naming things in code or docs.

For running a node (not developing it), see the
[Operator Guide](operator-guide.md) instead.

## Prerequisites

- **Node.js ≥ 22.5** (`engines` in [`package.json`](../package.json); CI runs on 22).
- **`reppo` CLI ≥ 0.8.0** on `PATH` for a locally-run node — the node checks at
  startup and warns on a version mismatch. The Docker image pins `@reppo/cli@0.8.4`.
- An **LLM API key** (Anthropic, OpenAI, Google, Surplus, or Virtuals) if you run
  onboarding locally — onboarding is a conversational LLM flow.

## Setup

```sh
npm install
```

That's it for the TypeScript package. The dashboard frontend lives in `web/` and
builds via the root `build` script (`npm --prefix web run build`).

<!-- AUTO-GENERATED: scripts — regenerate from package.json, do not hand-edit -->
## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TS (`tsc -p tsconfig.json`) then build the `web/` dashboard |
| `npm start` | Run the compiled node (`node dist/index.js`) — requires `npm run build` first |
| `npm test` | Run the full suite once (vitest) |
| `npm run test:watch` | Run vitest in watch mode |
| `npm run typecheck` | Type-check with no emit (`tsc --noEmit`) |
<!-- END AUTO-GENERATED -->

## Tests

Vitest, Node environment. Config in [`vitest.config.ts`](../vitest.config.ts).

- **Discovery**: `src/**/*.test.ts` (unit, colocated) and `test/**/*.test.ts`
  (integration).
- **Integration**: [`test/integration/cliBoundary.test.ts`](../test/integration/cliBoundary.test.ts)
  exercises the boundary against the `reppo` CLI; fixtures live in
  `test/fixtures/` (recorded CLI JSON, RSS, leaderboard samples).
- **Writing new tests**: colocate unit tests next to the source
  (`src/<area>/foo.test.ts`). Add new CLI/network shapes as fixtures under
  `test/fixtures/` rather than hitting the live network.

`node:sqlite` is kept external in vitest config (newer than Vite's builtin
externals list) — don't bundle it.

```sh
npm test            # once
npm run test:watch  # while iterating
```

## Code style

- TypeScript `strict` mode, ES2022, NodeNext modules (see
  [`tsconfig.json`](../tsconfig.json)). `rootDir` is `src/`.
- Match the surrounding code — comment density, naming, idiom. Source is
  organized by concern under `src/` (`adapter`, `voter`, `minter`, `panel`,
  `rubric`, `onboarding`, `dashboard`, `reppo`, `wallet`, `runtime`, ...).
- No dedicated linter/formatter is configured; `typecheck` is the gate.

<!-- AUTO-GENERATED: pr-checklist — mirrors .github/workflows/ci.yml -->
## PR checklist

CI (`.github/workflows/ci.yml`) runs on every PR and on push to `main`. Reproduce
it locally before opening a PR — same order, all must pass:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

- [ ] `npm run typecheck` clean
- [ ] `npm test` green (add/adjust fixtures for new CLI/network shapes)
- [ ] `npm run build` succeeds (TS + dashboard)
- [ ] Terminology matches [`CONTEXT.md`](../CONTEXT.md)
- [ ] Behavior-changing decisions captured in an ADR under [`docs/adr/`](adr/) if architectural
<!-- END AUTO-GENERATED -->

## Where things are documented

| Topic | Location |
|-------|----------|
| Running / operating a node | [`docs/operator-guide.md`](operator-guide.md) |
| Architecture | [`docs/design/2026-06-02-orquestra-design.md`](design/2026-06-02-orquestra-design.md) |
| Key decisions | [`docs/adr/`](adr/) |
| Feature specs | `docs/superpowers/specs/` |
| Operational runbooks | [`docs/runbooks/`](runbooks/) |
| Bootstrap secrets / env | [`.env.example`](../.env.example) (documented inline) |
