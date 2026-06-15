# Contributing to Orquestra

Thanks for helping build Reppo's self-hosted swarm node. This is a beta —
issues and PRs are welcome.

## Reporting bugs

Open a GitHub issue with:

- the image tag or commit you ran (`ghcr.io/reppo-labs/orquestra:<tag>`),
- your Node version if running from source (`node -v`; the node needs ≥ 22.5),
- the datanet(s) involved and whether vote/mint was enabled,
- relevant **redacted** node logs (`docker compose logs`) — never paste your
  `.env`, wallet key, RPC key, or LLM key. The node redacts secrets in its own
  logs, but double-check before posting.

For **security** issues do not open a public issue — see [SECURITY.md](SECURITY.md).

## Development setup

Requires Node ≥ 22.5 (the node uses `node:sqlite`). A `.nvmrc` is provided.

```sh
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest — unit + integration
npm run build         # tsc backend + build the web dashboard
npx vitest run src/voter/score.test.ts   # a single test file
```

The dashboard SPA in `web/` is a separate package:

```sh
npm --prefix web install
npm --prefix web run test
npm --prefix web run dev   # Vite dev server
```

CI runs `typecheck → test (root + web) → build` on Node 22; all must pass.

## Conventions

- **Read `CONTEXT.md` first** — the controlled vocabulary (node/agent,
  onboarding/bootstrap secrets, strategy/config) is deliberate; match it in code
  and docs.
- ESM throughout (`"type": "module"`, `NodeNext`): **import with `.js`
  extensions even from `.ts` sources**.
- TypeScript `strict`. Tests are colocated `*.test.ts` next to the source.
- Keep changes minimal and root-caused. The **budget caps are the security
  boundary** — changes under `src/wallet/` get extra scrutiny; never weaken the
  refuse-before-signing invariant.
- Architecture lives in `CLAUDE.md` and `docs/adr/`; check there before large
  changes.

## Pull requests

- Branch from `main`; keep PRs focused.
- Make sure `npm run typecheck`, `npm test`, `npm --prefix web run test`, and
  `npm run build` all pass before requesting review.
- Describe operator-facing impact (does it change spend, the dashboard, or
  onboarding?).
