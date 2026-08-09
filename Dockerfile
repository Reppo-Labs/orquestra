FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY web/package*.json ./web/
RUN npm ci --prefix web
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && npm i -g @reppo/cli@0.12.8
# @reppo/cli@0.12.8: robinhood grant-access/mint-pod accept --token primary as an alias
# for the subnet token — orquestra passes it for non-REPPO access fees; 0.12.7 rejected
# it with INVALID_TOKEN, failing every robinhood grant (hit live on datanet 3).
# 0.12.7: robinhood mint-pod Phase-2 publishing + register-agent target the
# robinhood.reppo.ai agents API (per-platform agent credentials) — needed for robinhood
# mints to surface on the platform and be voteable.
# 0.12.6: --network robinhood (chain 4663, RBV1 contracts) — REQUIRED for
# REPPO_NETWORK=robinhood nodes: every vote/mint/query the node shells out goes through
# the CLI, and earlier versions reject the network with INVALID_NETWORK.
# 0.12.5: query datanet surfaces the remaining rewards pool
# (getSubnetReppoSeedings/getSubnetPrimaryTokenSeedings) — operator-side runway visibility;
# the node reads the same getters directly over RPC, so this pin is not load-bearing for it.
# 0.12.4: mint-pod auto-approves the PodManager publishing fee (ensureAllowance,
# like lock/grant-access) — before this, every fresh wallet's FIRST mint reverted
# InsufficientAllowance() until a manual `reppo approve --spender pod-manager`.
# 0.12.3: register-agent --is-orquestra — platform resolves on-chain pod ids
# on /votes for Orquestra agents (0.12.1: post-approve allowance-visibility poll)
# where a fresh wallet's first lock/grant-access reverted InsufficientAllowance (0x13be252b)
# right after a successful auto-approve. 0.12.0: `list pods --all` surfaces the pod's full description + media url —
# lets the voter score the real writeup instead of a client-rendered SPA shell (the node
# reads this in parsePods). 0.11.0: query datanet surfaces the per-mint publishing fee
# (publishingFeeREPPO/publishingFeePrimaryToken) — separate from and additional to
# the one-time access fee; lets the node pre-flight mint balance instead of eating a
# TransferAmountExceedsBalance revert. Also adds query voter-emissions-due (claimability
# pre-flight for claim-voter-emissions: voted && !claimed, no amount — V2 has no
# per-voter due-amount view). 0.10.0: adds claim-voter-emissions (claimVoterEmissions) so
# the node can collect the VOTER share earned for curating other operators' pods —
# previously unclaimable (claim-emissions covers only the pod-owner share). 0.9.0: lock
# + grant-access auto-approve the ERC20 allowance (unlimited
# approve() + wait when short) so an operator never has to send approve() by hand —
# removes the manual-cast onboarding blocker. 0.8.6: grant-access --token primary (pay
# a datanet's access fee in its primary token, e.g. $EXY) + query datanet surfaces
# primaryToken {address, symbol, decimals} + approve --token <addr>. Gates the node's
# non-REPPO access path (NONREPPO_GRANT_MIN_VERSION=0.8.5). 0.8.4 added gasEth in write
# results; 0.8.0 added datanet rubric metadata + epoch data.
COPY package*.json ./
RUN npm ci --omit=dev
# Stamp the release version into the package.json this image ships. The node reports it
# as telemetry's `orquestraVersion` (src/telemetry/payload.ts reads ../../package.json
# from dist/), and the repo's package.json is pinned at 0.1.0 because releases are
# TAG-driven (auto-release.yml computes vX.Y.Z from git tags and never commits back to
# main). Without this every node in the fleet reported "0.1.0" regardless of the release
# it was running, so telemetry could not tell v0.4.10 from v0.4.54 — errors could not be
# correlated to a release, nor a fix confirmed as rolled out.
# Unset (a local `docker build`) leaves package.json untouched, so dev builds are
# unchanged and still report 0.1.0 — which is honest for an unreleased build.
ARG ORQUESTRA_VERSION
RUN if [ -n "$ORQUESTRA_VERSION" ]; then \
      npm pkg set "version=$ORQUESTRA_VERSION" \
      && echo "stamped version $(node -p "require('./package.json').version")"; \
    fi
COPY --from=build /app/dist ./dist
# The dashboard bind is NOT set here on purpose: the code defaults to 127.0.0.1
# (loopback), so a bare `docker run -p 7070:7070 <image>` does NOT expose the
# unauthenticated panel (ADR 0002). The provided docker-compose.yml sets
# DASHBOARD_HOST=0.0.0.0 itself, because its `127.0.0.1:7070:7070` host mapping forwards
# to the container's bridge IP — there the host mapping is the exposure boundary, and
# the override lives next to it. Do NOT bake 0.0.0.0 into the image default.
ENV ORQUESTRA_DATA_DIR=/data DASHBOARD_PORT=7070
# Ownership BEFORE `VOLUME /data` — filesystem changes after a VOLUME declaration
# are discarded by some builders (kaniko, buildah, legacy). With this ordering the
# anonymous-volume case is owned by `node`; a host bind-mount may still need a
# one-time `chown -R 1000` on the host dir.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data
# Run as the unprivileged node user (ships with the base image).
USER node
# Read-only dashboard. Expose to localhost with `-p 127.0.0.1:7070:7070`.
EXPOSE 7070
# Liveness: the dashboard serves /api/health whenever the node process is up.
# Honors DASHBOARD_PORT so a custom port still passes the probe.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD curl -fsS "http://127.0.0.1:${DASHBOARD_PORT}/api/health" > /dev/null || exit 1
# First-run configure requires -it AND valid LLM_* env vars (onboarding is conversational).
ENTRYPOINT ["node", "dist/index.js"]
