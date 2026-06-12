# Implementation plan — Docker distribution for node operators

Derived from ADR 0001 (published image + compose + dashboard onboarding) and
ADR 0002 (unauthenticated dashboard, localhost-bind + SSH tunnel). Goal: an
operator goes from zero to an earning node without building from source or
hand-writing `docker run` flags.

Target outcome (audience A):
```
cp .env.example .env      # paste wallet key + LLM key
docker compose up -d
ssh -L 7070:localhost:7070 <host>   # then open http://localhost:7070, onboard
```

## Phase 1 — Publish a versioned image to GHCR

- **Set a real version.** `package.json` is `0.0.0`; image tags need meaning.
  Adopt git-tag-driven versioning (`v0.1.0` → image tags `0.1.0` + `latest`).
  `private: true` stays (it only blocks npm publish, not the image).
- **`.github/workflows/release.yml`**: on `push: tags: v*`, build the existing
  Dockerfile, push `ghcr.io/reppo-labs/orquestra:<semver>` and `:latest`.
  Use `docker/build-push-action`, `permissions: packages: write`, log in with
  `GITHUB_TOKEN`. Build runs the same multi-stage Dockerfile (web build + tsc).
- Make the package public in the org's GHCR settings after the first push.
- **Verify**: tag a prerelease, confirm CI pushes, `docker pull` the tag on a
  clean machine, `docker run` it serves the dashboard.

## Phase 2 — `docker-compose.yml` + `.env.example`

- **`docker-compose.yml`** (repo root):
  - `image: ghcr.io/reppo-labs/orquestra:latest` (operators pin a version)
  - `env_file: .env`
  - `volumes: orquestra-data:/data` (named volume) + declare it
  - `ports: "127.0.0.1:7070:7070"`  ← localhost bind per ADR 0002
  - `restart: unless-stopped`
  - healthcheck inherits from the image
- **`.env.example`**: `REPPO_PRIVATE_KEY=`, `LLM_PROVIDER=`, `LLM_API_KEY=`,
  `RPC_URL=`, `PINATA_JWT=`, `DASHBOARD_PORT=7070`. Comment each. NO
  `DASHBOARD_TOKEN` line yet (Phase 4). `.env` already gitignored — confirm.
- **Verify**: `docker compose up -d` on a fresh dir with a filled `.env` →
  healthy; `curl 127.0.0.1:7070/api/onboarding/status` → `{needed:true}`.

## Phase 3 — First-run + README rewrite

- **Confirm the no-TTY wait path** (already in `src/index.ts`): with no TTY and
  the dashboard enabled, the node waits for dashboard onboarding rather than the
  terminal interview. Add an explicit startup log line pointing the operator to
  the tunnel command + URL while it waits.
- **README "Run a node" rewrite** to the pull-based quickstart above:
  1. `cp .env.example .env`, fill secrets
  2. `docker compose up -d`
  3. SSH-tunnel, open the dashboard, onboard (strategy)
  4. update path: `docker compose pull && docker compose up -d`
  - Move build-from-source (`docker build`) to an "Audit / build from source"
    appendix. Keep the `orquestra configure` terminal path documented as the
    headless/CI fallback only.
- **Verify**: a reader following only the new quickstart reaches an onboarded,
  running node (dry-run on a clean VPS or local Docker).

## Phase 4 — Optional dashboard secret (DEFERRED — build when audience B lands)

Not built now (ADR 0002). Record the integration point so it's a flag, not a
re-architecture: re-add an opt-in `DASHBOARD_TOKEN` env that, when set, gates the
write routes (the gate removed in PR #31); when unset, the dashboard stays open
(today's behavior). Then a `0.0.0.0` bind + secret becomes safe for non-tunnel
operators. Add `.env.example` line + README section at that time.

## Out of scope

- Binary / npm distribution (rejected in ADR 0001).
- Custodying secrets in the dashboard (contradicts self-custody).
- Multi-node / hosted orchestration.

## Risks

- GHCR visibility/permissions misconfig → first pull 403s. Verify public access
  explicitly after first push.
- Operators skip the SSH tunnel and expose `:7070` → unauthenticated config panel
  on a funded node. README must make the tunnel the obvious path and state the
  risk (mirrors ADR 0002). This is the strongest pull toward doing Phase 4 early.
- `:latest` drift — document pinning a version tag in compose for production.
