# Distribute Orquestra as a published Docker image + compose, onboarded via the dashboard

**Status:** accepted

## Context

Orquestra is a long-running JS/TS daemon that holds a funded wallet key and shells
out to the Node-based `@reppo/cli`. The audience is node operators: crypto-native
and terminal-comfortable at launch (audience A), with a semi-technical earner as the
growth target (audience B). We needed a blessed way to ship and first-run it.

## Decision

Distribute a **published, versioned Docker image** (`ghcr.io/reppo-labs/orquestra:<version>`,
public) plus a `docker-compose.yml`. Operators pull and run; they do not build.
First-run configuration happens in the **dashboard** (`docker compose up -d`, open
the dashboard, onboard) — the terminal `orquestra configure` interview is kept only
as a headless/CI fallback. The Dockerfile remains for build-from-source as the audit
path. Updates are `docker compose pull && docker compose up -d`.

## Considered options

- **Single static binary** (geth-style) — rejected: it would still require Node 20 +
  the `reppo` CLI on `PATH`, so it solves nothing the image already solves. Docker is
  precisely what bundles that runtime.
- **npm global CLI** (`npm i -g`) — rejected as the blessed path: pushes Node-version
  and `reppo`-CLI installation onto the operator and lacks the restart/healthcheck
  lifecycle a keyed always-on daemon needs.
- **Build-from-source Docker (status quo)** — kept as the audit path, rejected as the
  default: every operator compiling and hand-writing `docker run` flags is the real
  friction, not Docker itself.

## Consequences

- A CI publish step and image-tagging scheme are now required (standard semver tags;
  not ADR-worthy on their own).
- Two onboarding implementations exist (dashboard HTTP + terminal). They share the
  core turn-runner, so the cost is bounded; the terminal path must keep working for
  headless/CI even though the blessed path never uses it.
- Bootstrap secrets remain an environment concern (see the config-split boundary):
  the dashboard configures **strategy**, never secrets.
