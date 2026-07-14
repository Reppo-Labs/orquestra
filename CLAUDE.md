# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Orquestra is Reppo's official self-hosted **agentic swarm node**. An operator runs one node on their own machine; each cycle it **votes** (curates) across any Reppo datanet and **mints** (publishes data pods) where it has a data adapter — bounded by a budget set during an LLM onboarding interview, signing with the operator's own wallet. It earns $REPPO only through voting + minting (there is no compute/inference earning path).

Read `CONTEXT.md` for the project's controlled vocabulary — the distinctions between **node / agent**, **onboarding / bootstrap secrets**, and **strategy / config** are deliberate and load-bearing. Match that language in code and docs.

## Commands

```sh
npm test              # vitest run — unit + integration (test/integration/cliBoundary.test.ts)
npm run test:watch    # vitest watch
npm run typecheck     # tsc --noEmit
npm run build         # tsc backend + build the web dashboard
npx vitest run src/voter/score.test.ts   # single test file
```

CI (`.github/workflows/ci.yml`) runs `typecheck → test → build` on Node 22. The web dashboard (`web/`) is a separate npm package (React + Vite); `npm run build` at the root also builds it via `npm --prefix web run build`.

`node:sqlite` is kept external in `vitest.config.ts` — it is newer than Vite's builtins list and must load from the Node runtime, not be bundled.

## Runtime model

`src/index.ts` is a thin shell: load env → construct services → dispatch argv (`configure` = onboarding only, default = start node) → handle SIGINT/SIGTERM (the node is PID 1 in its container, so signals must be handled explicitly or `docker stop` is ignored). **All cycle wiring lives in `src/runtime/wiring.ts`** and is unit-tested there — keep `index.ts` orchestration-only.

Boot order matters: the **dashboard starts first** because on a fresh node it hosts conversational onboarding; the **scheduler starts only once a strategy config exists** (`src/runtime/scheduler.ts` → `buildTick`). Config is **hot-reloaded each cycle** (`reloadConfig`), validated, with last-good fallback on failure.

A cycle (`src/runtime/cycle.ts → runCycle`) iterates configured datanets and, per datanet, votes (if enabled + a rubric exists) and mints (if enabled + an adapter exists + capable). **Per-datanet isolation is intentional**: a failure (RPC error, missing rubric on an old CLI, flaky adapter) skips only that datanet, is recorded, and never aborts the cycle or other datanets.

## Architecture (big picture)

- **`reppo/`** — the only hard external contract is the `reppo` CLI (≥0.8.0, checked at startup with a warn-only version preflight). All on-chain reads/writes go through it: query datanet/balance/epoch/pods/emissions, vote, mint, register agent. `exec.ts`/`cli.ts` wrap CLI invocation; the rest are typed query/command wrappers with fixture-backed tests.
- **`rubric/`** — a datanet's policy is **not** hand-authored. `reppo query datanet --json` surfaces the creator's onboarding text (`subnetDescription`, `onboardingVoters` = the 1–10 vote rubric, `onboardingPublishers` = the mint spec). The rubric loader parses that straight from the CLI. Rubric → can vote; rubric + adapter → can mint.
- **`adapter/`** — pluggable per-datanet data sources for minting. Each adapter (`hyperliquid/`, `gdelt/`, `sports/`) implements `DatanetAdapter` (`adapter/types.ts`). **Register new adapters in the `adapters: [...]` array in `src/index.ts`**; routing is by adapter id from config. Hyperliquid is the reference adapter.
- **`voter/` + `minter/`** — datanet-agnostic scoring + selection. `score.ts` scores candidates/pods, `select.ts` picks within caps.
- **`panel/`** — multi-agent LLM deliberation (personas, judges, scorers) for decisions.
- **`wallet/`** — `BudgetLedger` (`ledger.ts`) is the single source of budget truth, persisted to `DATA_DIR/budget-ledger.json`. `WalletExecutor` (`executor.ts`) reserves/records spend on the ledger and **refuses to sign before exceeding caps, not after**. On a corrupt ledger the node refuses to run rather than lose track of spend (`LedgerCorruptError`).
- **`llm/`** — model-agnostic via the Vercel AI SDK. Providers: `anthropic | anthropic-oauth (Claude subscription) | openai | google | surplus | virtuals | usepod`. `resolveModel(provider, apiKey)`; per-datanet + node-default model routing; `usage.ts` tracks per-cycle token cost for the dashboard.
- **`onboarding/`** — conversational interview (LLM-driven, `agent.ts`) that produces a declarative strategy config (`build.ts` → `persist.ts`). Re-runnable. `configure` subcommand runs it in the terminal as a headless/CI fallback.
- **`dashboard/`** — Node HTTP server (`server.ts`) serving the built `web/` SPA + JSON endpoints (pnl, snapshot, activity log, earn status, health) and hosting the strategy chat. Activity is SQLite-backed (`node:sqlite`).
- **`config/`** — `StrategyConfig` Zod schema (`schema.ts`). Strictness levels (`conservative | balanced | aggressive`) map to `STRICTNESS_THRESHOLDS`.

## Key invariants

- **Budget caps are the real security boundary** (the wallet key sits in `.env` in plaintext). The ledger refuses before signing; never weaken this. Enabling a datanet is the consent to pay its one-time subnet access grant — grants are cached per subnet and are NOT budget-capped (`budget.grantReppoMax` was retired; `config/load.ts` strips it with a warning).
- **The dashboard is unauthenticated and localhost-bound on purpose** — it has no login, so exposure equals full control of strategy + budget. It is reached over an SSH tunnel. Never add a default that binds it to a public interface.
- Setup steps (veREPPO lock, Reppo agent-id registration) are **idempotent** — they run every start and must no-op when already done, or restarts error.
- Secrets are read from the environment only, never from the dashboard, never logged. `src/util/redact.ts` redacts before logging.

## Conventions

- ESM throughout (`"type": "module"`, `NodeNext`). **Import with `.js` extensions** even from `.ts` sources.
- TypeScript `strict`. Tests are colocated `*.test.ts` next to source (vitest, `node` environment); cross-CLI-boundary integration tests live in `test/` with JSON/XML fixtures in `test/fixtures/`.
- Node ≥ 22.5 (uses `node:sqlite`).

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, label string = role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root + `docs/adr/`. See `docs/agents/domain.md`.
